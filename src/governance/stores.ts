import type { Proposal } from '../types.js';
import { readJson, writeJsonAtomic } from '../util/fsx.js';

interface ProposalFile {
  version: 1;
  nextSeq: number;
  proposals: Proposal[];
}

const MAX_KEPT = 500;
const TERMINAL = new Set(['blocked', 'rejected', 'rolled_back', 'verify_failed', 'conflict', 'failed', 'expired', 'applied']);

/** Proposals live in one JSON file. Writers must hold the engine lock. */
export class ProposalStore {
  constructor(private readonly file: string) {}

  load(): ProposalFile {
    const data = readJson<ProposalFile | null>(this.file, null);
    if (!data) return { version: 1, nextSeq: 1, proposals: [] };
    return data;
  }

  save(data: ProposalFile): void {
    if (data.proposals.length > MAX_KEPT) {
      // Drop the oldest finished proposals first. Open ones are never dropped.
      let excess = data.proposals.length - MAX_KEPT;
      data.proposals = data.proposals.filter((p) => {
        if (excess > 0 && TERMINAL.has(p.status)) {
          excess--;
          return false;
        }
        return true;
      });
    }
    writeJsonAtomic(this.file, data);
  }

  list(): Proposal[] {
    return this.load().proposals;
  }

  get(id: string): Proposal | undefined {
    return this.load().proposals.find((p) => p.id === id);
  }
}

interface ControlFile {
  killSwitch: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

/** Human-only controls. The AI has no tool that writes here. */
export class ControlStore {
  constructor(private readonly file: string) {}

  load(): ControlFile {
    return readJson<ControlFile>(this.file, { killSwitch: false });
  }

  save(data: ControlFile): void {
    writeJsonAtomic(this.file, data);
  }
}
