// Runs every compiled test file with Node's built-in test runner (works the same on Windows, macOS and Linux).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'dist', 'test');
if (!fs.existsSync(dir)) {
  console.error('No compiled tests found. Run "npm run build" first.');
  process.exit(1);
}
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
