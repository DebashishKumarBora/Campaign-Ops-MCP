import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256 } from '../util/hash.js';
import { ensureDir } from '../util/fsx.js';

export type AuditType =
  | 'proposal_created'
  | 'proposal_blocked'
  | 'approved'
  | 'rejected'
  | 'apply_refused'
  | 'conflict'
  | 'apply_failed'
  | 'applied'
  | 'verify_failed'
  | 'rollback_requested'
  | 'rolled_back'
  | 'expired'
  | 'kill_switch_on'
  | 'kill_switch_off'
  | 'tamper_detected';

export interface AuditEntry {
  seq: number;
  ts: string;
  type: AuditType;
  actor: string;
  proposalId?: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  brokenAtSeq?: number;
  problem?: string;
}

const GENESIS = 'GENESIS';

function entryHash(e: Omit<AuditEntry, 'hash'>): string {
  return sha256(canonical({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, proposalId: e.proposalId, details: e.details, prevHash: e.prevHash }));
}

/**
 * Append-only, hash-chained audit log (one JSON object per line).
 * Each entry stores the hash of the one before it, so editing or deleting
 * any past line breaks the chain and verify() reports exactly where.
 * Callers must hold the engine lock while appending.
 */
export class AuditLog {
  constructor(private readonly file: string) {}

  readAll(): AuditEntry[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        out.push({ seq: -1, ts: '', type: 'tamper_detected', actor: 'system', details: { unreadableLine: line.slice(0, 120) }, prevHash: '', hash: '' });
      }
    }
    return out;
  }

  append(input: { ts: string; type: AuditType; actor: string; proposalId?: string; details?: Record<string, unknown> }): AuditEntry {
    ensureDir(path.dirname(this.file));
    const all = this.readAll();
    const last = all[all.length - 1];
    const base: Omit<AuditEntry, 'hash'> = {
      seq: last ? last.seq + 1 : 1,
      ts: input.ts,
      type: input.type,
      actor: input.actor,
      proposalId: input.proposalId,
      details: input.details ?? {},
      prevHash: last ? last.hash : GENESIS,
    };
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  verify(): ChainCheck {
    const all = this.readAll();
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const e of all) {
      if (e.seq !== expectedSeq) return { ok: false, count: all.length, brokenAtSeq: expectedSeq, problem: `Entry ${expectedSeq} is missing or out of order.` };
      if (e.prevHash !== prev) return { ok: false, count: all.length, brokenAtSeq: e.seq, problem: `Entry ${e.seq} does not link to the entry before it.` };
      const { hash, ...rest } = e;
      if (entryHash(rest) !== hash) return { ok: false, count: all.length, brokenAtSeq: e.seq, problem: `Entry ${e.seq} was modified after it was written.` };
      prev = hash;
      expectedSeq++;
    }
    return { ok: true, count: all.length };
  }

  recent(limit: number, proposalId?: string): AuditEntry[] {
    const all = this.readAll().filter((e) => !proposalId || e.proposalId === proposalId);
    return all.slice(Math.max(0, all.length - limit)).reverse();
  }
}
