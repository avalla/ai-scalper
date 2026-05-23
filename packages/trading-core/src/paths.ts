import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";

function findProjectRoot(start: string): string | null {
  let current = start;
  const { root } = parse(current);
  while (true) {
    if (existsSync(join(current, "bun.lock"))) {
      return current;
    }
    if (current === root) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveProjectPath(relativePath: string): string {
  if (isAbsolute(relativePath)) {
    return relativePath;
  }
  const cwd = process.cwd();
  const root = findProjectRoot(cwd);
  return join(root ?? cwd, relativePath);
}
