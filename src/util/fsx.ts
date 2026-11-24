import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${path.basename(file)}: ${err.message}`);
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Writes JSON to a temp file, then renames it into place, so readers never see half a file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameWithRetry(tmp, file);
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Windows antivirus and indexers briefly lock files. Retry before giving up.
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 20) {
        sleepSync(25 * (attempt + 1));
        continue;
      }
      try {
        fs.unlinkSync(from);
      } catch {
        // ignore
      }
      throw e;
    }
  }
}

/**
 * A lock that works across processes (an MCP server and a standalone console
 * can share one data folder) and across overlapping async calls in one process.
 * Calls must not be nested: the lock is not re-entrant.
 */
export class DirLock {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly lockFile: string,
    private readonly staleMs = 30_000,
    private readonly timeoutMs = 15_000,
  ) {}

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      await this.acquireFile();
      try {
        return await fn();
      } finally {
        this.releaseFile();
      }
    } finally {
      release();
    }
  }

  private async acquireFile(): Promise<void> {
    const start = Date.now();
    ensureDir(path.dirname(this.lockFile));
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        fs.closeSync(fd);
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        try {
          const stat = fs.statSync(this.lockFile);
          if (Date.now() - stat.mtimeMs > this.staleMs) {
            fs.unlinkSync(this.lockFile);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - start > this.timeoutMs) {
          throw new Error(
            'Timed out waiting for the data folder lock. If no other Campaign Ops process is running, delete data/.lock and try again.',
          );
        }
        await sleep(20 + Math.random() * 30);
      }
    }
  }

  private releaseFile(): void {
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      // already gone
    }
  }
}
