import { join } from "node:path";

function workerAppDir(): string {
  const cwd = process.cwd();
  return cwd.endsWith("/apps/worker") ? cwd : join(cwd, "apps", "worker");
}

async function main(): Promise<void> {
  const cwd = workerAppDir();
  const workerProcess = Bun.spawn({
    cmd: ["bun", "src/index.ts"],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "inherit",
  });

  const stdout = workerProcess.stdout;
  if (!stdout) {
    throw new Error("Worker stdout is not available");
  }

  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let workersReady = false;
  let sessionEnqueued = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    process.stdout.write(chunk);

    if (!workersReady && chunk.includes('"event":"workers-ready"')) {
      workersReady = true;
    }

    if (!sessionEnqueued && workersReady) {
      sessionEnqueued = true;
      const enqueueProcess = Bun.spawn({
        cmd: ["bun", "src/enqueue-trader-session.ts"],
        cwd,
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await enqueueProcess.exited;
      if (exitCode !== 0) {
        throw new Error(`Session enqueue exited with code ${exitCode}`);
      }
    }
  }

  const workerExitCode = await workerProcess.exited;
  if (workerExitCode !== 0) {
    throw new Error(`Worker exited with code ${workerExitCode}`);
  }
}

await main();
