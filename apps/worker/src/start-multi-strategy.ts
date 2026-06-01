/**
 * Multi-strategy supervisor.
 *
 * Spawns N trader subprocesses, one per config file listed in the
 * `STRATEGY_CONFIGS` env var (comma-separated). Each child inherits the
 * parent env but has `CONFIG_FILE=<name>` overridden so it loads the
 * intended strategy.
 *
 * Output is interleaved on stdout; each line is prefixed with `[<name>]`
 * so logs from N strategies can be tailed in one stream. SIGTERM / SIGINT
 * propagate to all children; a crashed child triggers a graceful shutdown
 * of the others (fail-fast — operator restarts via systemd / process mgr).
 *
 * The shared worker stack (BullMQ workers, Bull Board, /health, optional
 * WS feeder, optional advisor) is NOT spawned here — it is meant to be
 * already running via `bun run up` (one shared instance feeds all
 * strategies). This script only manages the trader processes.
 *
 * Usage:
 *   STRATEGY_CONFIGS=config.funding-arb.json,config.basis-arb.json \
 *     bun apps/worker/src/start-multi-strategy.ts
 */

import { join } from "node:path";

function traderAppDir(): string {
  const cwd = process.cwd();
  if (cwd.endsWith("/apps/worker")) return join(cwd, "..", "trader");
  return join(cwd, "apps", "trader");
}

interface ChildEntry {
  name: string;
  proc: ReturnType<typeof Bun.spawn>;
}

export function parseConfigs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.trim().split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function deriveStrategyName(configFile: string): string {
  return configFile.replace(/^config\./, "").replace(/\.json$/, "");
}

async function pipeWithPrefix(
  stream: ReadableStream<Uint8Array> | null,
  prefix: string,
  target: NodeJS.WriteStream,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      if (buffer.length > 0) target.write(`${prefix} ${buffer}\n`);
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      target.write(`${prefix} ${line}\n`);
    }
  }
}

async function main(): Promise<void> {
  const configs = parseConfigs(process.env.STRATEGY_CONFIGS);
  if (configs.length === 0) {
    console.error(
      "STRATEGY_CONFIGS is empty. Example: "
      + 'STRATEGY_CONFIGS="config.funding-arb.json,config.basis-arb.json"',
    );
    process.exit(2);
  }

  const dir = traderAppDir();
  const children: ChildEntry[] = [];

  for (const cfg of configs) {
    const name = deriveStrategyName(cfg);
    const proc = Bun.spawn({
      cmd: ["bun", "src/index.ts"],
      cwd: dir,
      env: { ...process.env, CONFIG_FILE: cfg },
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push({ name, proc });
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: "multi-strategy-spawned",
      name, configFile: cfg, pid: proc.pid,
    }));
  }

  // Pipe each child's stdout / stderr through a per-strategy prefix.
  const pipes: Array<Promise<void>> = [];
  for (const c of children) {
    const tag = `[${c.name}]`;
    pipes.push(pipeWithPrefix(c.proc.stdout as any, tag, process.stdout));
    pipes.push(pipeWithPrefix(c.proc.stderr as any, `${tag}!`, process.stderr));
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: "multi-strategy-shutdown", signal,
    }));
    for (const c of children) {
      if (!c.proc.killed) {
        try { c.proc.kill(signal); } catch { /* ignore */ }
      }
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Wait for any child to exit → fail-fast.
  const exits = children.map(async (c) => {
    const code = await c.proc.exited;
    return { name: c.name, code };
  });
  const first = await Promise.race(exits);
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: "multi-strategy-child-exited",
    name: first.name, exitCode: first.code,
  }));

  // Tear the rest down so we don't leak orphans.
  shutdown("SIGTERM");
  await Promise.allSettled(exits);
  await Promise.allSettled(pipes);

  if (first.code !== 0) process.exit(first.code);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}
