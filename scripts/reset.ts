/**
 * npm run reset
 * Rebuilds the sandbox account and clears proposals, the audit log and the
 * kill switch. Your console key is kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';

const app = createApp();
const dir = app.config.dataDir;
for (const file of ['proposals.json', 'audit.jsonl', 'control.json', '.lock']) {
  fs.rmSync(path.join(dir, file), { force: true });
}
app.backend.reset();
console.log(`Sandbox reset in ${dir}`);
console.log('Fresh synthetic account created. Proposals, audit log and kill switch cleared. Console key kept.');
