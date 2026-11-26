/**
 * npm run demo
 * A narrated walk through every guardrail, run against a throwaway copy of the
 * sandbox (your real sandbox data is not touched). The "person" approvals here
 * are simulated so the whole story fits in one run; in real use only a person
 * can approve, through the console or an approval prompt.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SandboxBackend } from '../src/backends/sandbox.js';
import { Engine } from '../src/governance/engine.js';
import { runDiagnostics } from '../src/governance/diagnostics.js';
import { checkPulse } from '../src/governance/pulse.js';
import { DEFAULT_POLICY } from '../src/config.js';
import type { Change, Proposal } from '../src/types.js';

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const red = c('31');
const green = c('32');
const yellow = c('33');
const blue = c('34');

const ACCOUNT = '123-456-7890';
const AGENT = 'agent (demo script)';
const PERSON = 'person (simulated for the demo)';

let step = 0;
function heading(title: string): void {
  step += 1;
  console.log(`\n${bold(`${step}. ${title}`)}`);
}

function show(p: Proposal): void {
  const label = p.status === 'blocked' ? red('BLOCKED') : p.status === 'pending_approval' ? yellow('WAITING FOR APPROVAL') : p.status;
  console.log(`   ${bold(p.id)} ${label}  ${p.summary}`);
  for (const check of p.checks) {
    if (check.status === 'fail') console.log(`     ${red('✕')} ${check.label}: ${check.detail ?? ''}`);
    else if (check.status === 'warn') console.log(`     ${yellow('!')} ${check.label}: ${check.detail ?? ''}`);
  }
  if (p.status === 'pending_approval') console.log(dim(`     ${p.checks.filter((x) => x.status === 'pass').length} checks passed, including the dry run.`));
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-ops-demo-'));
const backend = new SandboxBackend(path.join(dataDir, 'sandbox.json'));
backend.ensure();
const engine = new Engine({ backend, dataDir, policy: DEFAULT_POLICY, scope: 'execute' });

async function propose(change: Change, reason: string): Promise<Proposal> {
  const p = await engine.propose({ accountId: ACCOUNT, change, reason, requestedBy: AGENT });
  show(p);
  return p;
}

async function approveAndApply(id: string): Promise<void> {
  await engine.approve(id, { by: PERSON, channel: 'console' });
  console.log(`   ${blue('✓')} ${id} approved by a person`);
  const out = await engine.apply(id, { actor: AGENT });
  const color = out.status === 'applied' ? green : out.status === 'refused' || out.status === 'conflict' ? yellow : red;
  console.log(`   ${color(out.status.toUpperCase())} ${out.message}`);
}

console.log(bold('\nCampaign Ops MCP: guardrails demo'));
console.log(dim(`Throwaway data folder: ${dataDir}`));

heading('The agent diagnoses the account');
const report = await runDiagnostics(backend, DEFAULT_POLICY, ACCOUNT, 30);
for (const f of report.findings) console.log(`   ${f.severity === 'high' ? red('●') : yellow('●')} ${f.id} ${f.title}${f.estimatedMonthlyImpact ? dim(` (${f.estimatedMonthlyImpact})`) : ''}`);
for (const t of report.protectedTermsNotNegated) console.log(dim(`   Not excluded on purpose: "${t.term}" (${t.protectedCategory})`));

heading('The agent asks for too much budget at once');
await propose({ type: 'set_campaign_budget', campaignId: 'c-202', newDailyBudget: 80 }, 'Northlight Generic converts best and loses 38% of impressions to budget.');

heading('The agent proposes the safe version instead');
const budget = await propose({ type: 'set_campaign_budget', campaignId: 'c-202', newDailyBudget: 50 }, 'Northlight Generic has the best cost per lead and loses about 38% of impressions to budget. +25% stays within policy.');

heading('A naive optimizer tries to exclude protected searches');
await propose(
  { type: 'add_negative_keywords', campaignId: 'c-102', keywords: [{ text: 'section 8 apartments', matchType: 'PHRASE' }, { text: 'wheelchair accessible apartments', matchType: 'PHRASE' }] },
  'These searches had zero conversions in 30 days.',
);

heading('The agent excludes only the irrelevant searches');
const negatives = await propose(
  { type: 'add_negative_keywords', campaignId: 'c-102', keywords: ['apartment jobs', 'how to become a leasing agent', 'storage units near me', 'apartment cleaning services', 'free furniture pickup'].map((text) => ({ text, matchType: 'PHRASE' as const })) },
  '$360 in 30 days went to job seekers and unrelated services with zero leads.',
);

heading('Ad copy with Fair Housing problems is stopped');
await propose(
  { type: 'update_ad_text', adId: 'a-3011', headlines: ['Ashgrove Commons', 'Perfect for Couples', 'Downtown Studios and 1 Beds'], descriptions: ['Quiet adults-only living near downtown.', 'Book your tour today.'] },
  'Refresh the copy to sound more premium.',
);

heading('Compliant copy that describes the home, not the people');
const copy = await propose(
  {
    type: 'update_ad_text',
    adId: 'a-3011',
    headlines: ['Ashgrove Commons', 'Downtown Studios and 1 Beds', 'Resort-Style Pool', 'Book a Tour Today'],
    descriptions: ['Quiet community near downtown with a resort-style pool and modern finishes.', 'Studios and 1 bedrooms with modern finishes. Schedule your tour today.'],
  },
  'The current ad says "adults-only" and "young professionals", which create Fair Housing risk. The new copy describes the home and amenities.',
);

heading('A person approves; the agent applies and verifies');
await approveAndApply(negatives.id);
await approveAndApply(copy.id);

heading('Someone edits the budget in Google Ads at the same moment');
await engine.approve(budget.id, { by: PERSON, channel: 'console' });
backend.externalEdit((s) => {
  s.campaigns.find((x) => x.id === 'c-202')!.dailyBudget = 45;
});
console.log(dim('   (simulated: the live budget changed from $40 to $45 outside this tool)'));
const conflict = await engine.apply(budget.id, { actor: AGENT });
console.log(`   ${yellow(conflict.status.toUpperCase())} ${conflict.message}`);
const fresh = await propose({ type: 'set_campaign_budget', campaignId: 'c-202', newDailyBudget: 55 }, 'Re-proposed from the new live value of $45: +22% keeps it within policy.');
await approveAndApply(fresh.id);

heading('Undo is a change too, and it is checked');
const undoCopy = await engine.requestRollback(copy.id, { requestedBy: AGENT, reason: 'Testing whether the old copy can be restored.' });
show(undoCopy);
const undoNeg = await engine.undoNow(negatives.id, PERSON);
console.log(`   ${green('UNDONE')} ${negatives.id} reverted by ${undoNeg.rollback.id} (${undoNeg.outcome?.status})`);

heading('The kill switch stops everything');
const pause = await propose({ type: 'set_campaign_status', campaignId: 'c-302', newStatus: 'PAUSED' }, 'Ashgrove Display spent about $590 in 30 days with zero leads.');
await engine.approve(pause.id, { by: PERSON, channel: 'console' });
await engine.setKillSwitch(true, PERSON);
const refused = await engine.apply(pause.id, { actor: AGENT });
console.log(`   ${yellow(refused.status.toUpperCase())} ${refused.message}`);
await engine.setKillSwitch(false, PERSON);
const resumed = await engine.apply(pause.id, { actor: AGENT });
console.log(`   ${green(resumed.status.toUpperCase())} after a person resumed changes: ${resumed.message}`);

heading('Pulse catches what a monthly report misses');
const pulse = await checkPulse(backend, ACCOUNT, { days: 28 });
for (const a of pulse.alarms) {
  console.log(`   ${red('ALARM')} ${a.title}`);
  console.log(dim(`     ${a.detail}`));
}

heading("The approval log is checked against the account's own record");
const witness = await engine.witness(ACCOUNT, 14);
console.log(`   ${witness.verdict === 'clean' ? green('✓') : red('✕')} ${witness.headline}`);
await backend.mutate(ACCOUNT, { type: 'set_campaign_status', campaignId: 'c-101', newStatus: 'PAUSED' }, { validateOnly: false });
const caught = await engine.witness(ACCOUNT, 14);
console.log(`   ${red('✕')} After a change made with the robot's key outside Campaign Ops: ${caught.headline}`);

heading('The audit log is tamper-evident');
const ok = engine.audit.verify();
console.log(`   ${green('✓')} Chain intact across ${ok.count} entries`);
const auditFile = path.join(dataDir, 'audit.jsonl');
const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
const target = JSON.parse(lines[4]);
target.actor = 'someone else';
lines[4] = JSON.stringify(target);
fs.writeFileSync(auditFile, lines.join('\n') + '\n');
const broken = engine.audit.verify();
console.log(`   ${red('✕')} After editing one line by hand: ${broken.problem}`);

console.log(`\n${bold('Done.')} Every change was proposed, checked, dry-run, approved by a person, re-checked, applied and verified.`);
console.log(dim('Next: npm run inspect to call the tools yourself, and npm run console to see the approval console.\n'));
fs.rmSync(dataDir, { recursive: true, force: true });
