import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * Finds the project folder by walking up from this file until it reaches the
 * package.json named campaign-ops-mcp. MCP clients start the server from any
 * working directory, so paths must never depend on process.cwd().
 */
export function projectRoot(): string {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const json = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string };
        if (json.name === 'campaign-ops-mcp') {
          cached = dir;
          return dir;
        }
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find the campaign-ops-mcp project folder (package.json).');
}

export function appVersion(): string {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(projectRoot(), 'package.json'), 'utf8')) as { version?: string };
    return json.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
