/**
 * Browser build of Campaign Ops. This imports the same engine, sandbox,
 * diagnostics and Fair Housing code the MCP server uses. Only the file
 * system, path and hashing libraries are swapped for in-memory versions
 * (see web/shims), so every guardrail behaves exactly as it does in Node.
 */
import { SandboxBackend } from '../src/backends/sandbox.js';
import { Engine } from '../src/governance/engine.js';
import { accountOverview, runDiagnostics } from '../src/governance/diagnostics.js';
import { checkPulse } from '../src/governance/pulse.js';
import { lintAd, protectedTermIn } from '../src/governance/fairHousing.js';
import { AuditLog } from '../src/governance/audit.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import * as memfs from './shims/fs.js';

export const ACCOUNT = '123-456-7890';
const DATA = '/sandbox';

export function createDemo() {
  memfs.reset();
  const backend = new SandboxBackend(`${DATA}/sandbox.json`);
  backend.ensure();
  const engine = new Engine({ backend, dataDir: DATA, policy: DEFAULT_POLICY, scope: 'execute' });
  return {
    backend,
    engine,
    policy: DEFAULT_POLICY,
    account: ACCOUNT,
    diagnostics: (days = 30) => runDiagnostics(backend, DEFAULT_POLICY, ACCOUNT, days),
    overview: (days = 30) => accountOverview(backend, ACCOUNT, days),
    /** Day-by-day alarms (the sandbox has a planted tracking outage). */
    pulse: (days = 28) => checkPulse(backend, ACCOUNT, { days }),
    /** The approval log checked against the sandbox's own change history. */
    witness: (days = 14) => engine.witness(ACCOUNT, days),
    state: () => backend.load(),
    /** Edits one audit line in a scratch copy and verifies it, without touching the real log. */
    tamperTest: () => {
      let raw = '';
      try {
        raw = memfs.readFileSync(`${DATA}/audit.jsonl`);
      } catch {
        return { ok: true, count: 0, problem: 'The audit log is empty. Make a change first.' };
      }
      const lines = raw.trim().split('\n');
      if (lines.length < 2) return { ok: true, count: lines.length, problem: 'Make at least two audited actions first.' };
      const target = Math.floor(lines.length / 2);
      const entry = JSON.parse(lines[target]);
      entry.actor = 'someone else';
      lines[target] = JSON.stringify(entry);
      memfs.writeFileSync('/scratch/audit.jsonl', lines.join('\n') + '\n');
      const result = new AuditLog('/scratch/audit.jsonl').verify();
      memfs.unlinkSync('/scratch/audit.jsonl');
      return { ...result, editedSeq: entry.seq };
    },
  };
}

export { lintAd, protectedTermIn, DEFAULT_POLICY };
