/**
 * npm run reset              rebuilds the sandbox account
 * npm run reset -- --all     also clears proposals, the audit log and the kill switch
 *
 * When a Google Ads account is connected, plain reset keeps proposals and the
 * audit log: they are the record of real changes made in Google Ads, and the
 * witness check needs them to match Google's own change history. Your console
 * key is always kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';

const app = createApp();
const dir = app.config.dataDir;
const all = process.argv.includes('--all');
const connected = Boolean(app.googleAds);

app.sandbox.reset();
console.log(`Sandbox rebuilt in ${dir}`);

if (all || !connected) {
  for (const file of ['proposals.json', 'audit.jsonl', 'control.json', '.lock']) {
    fs.rmSync(path.join(dir, file), { force: true });
  }
  console.log('Proposals, audit log, change windows and kill switch cleared. Console key kept.');
  if (all && connected) {
    console.log('');
    console.log('Note: Google Ads still remembers changes the robot made in the last 30 days.');
    console.log('Without the cleared records, the witness check will flag those changes as not approved.');
  }
} else {
  console.log('Proposals and the audit log were kept, because a Google Ads account is connected.');
  console.log('They are the record of real changes in Google Ads, and the witness check matches them with Google.');
  console.log('To clear them anyway, run: npm run reset -- --all');
}
