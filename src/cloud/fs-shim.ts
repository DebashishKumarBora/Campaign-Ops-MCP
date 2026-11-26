/**
 * A replacement for node:fs, so the unmodified engine, sandbox and audit log
 * run inside a Cloudflare Durable Object. Files live in the object's own
 * SQLite database, split into rows of up to 256K characters; the Worker build
 * aliases node:fs here.
 *
 * Lock files and temporary files stay in memory: one Durable Object is a
 * single instance, so a lock never needs to outlive it, and a temp file is
 * renamed into place straight away.
 */

export interface FileRow {
  data: string;
  mtime: number;
}

export interface SyncFileStore {
  get(path: string): FileRow | undefined;
  put(path: string, data: string, mtime: number): void;
  append(path: string, data: string, mtime: number): void;
  delete(path: string): void;
  list(prefix: string): string[];
}

/** SQL storage of a Durable Object (only the synchronous exec call is used). */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/**
 * Longest piece of a file kept in one row, in JavaScript characters. A row in a
 * Durable Object's database can hold at most 2 MB; 256K characters is at most
 * 768 KB of UTF-8, so the audit log can grow for years without hitting it.
 */
export const CHUNK_CHARS = 256 * 1024;

/** Splits text into pieces of at most `max` characters without cutting an emoji (a surrogate pair) in half. */
export function splitText(text: string, max = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out.length ? out : [''];
}

export function sqlFileStore(sql: SqlLike, max = CHUNK_CHARS): SyncFileStore {
  sql.exec('CREATE TABLE IF NOT EXISTS file_chunks (path TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, len INTEGER NOT NULL, mtime INTEGER NOT NULL, PRIMARY KEY (path, n))');
  const insert = (path: string, pieces: string[], from: number, mtime: number) => {
    pieces.forEach((piece, k) => sql.exec('INSERT INTO file_chunks (path, n, data, len, mtime) VALUES (?, ?, ?, ?, ?)', path, from + k, piece, piece.length, mtime));
  };
  const store: SyncFileStore = {
    get(path) {
      const rows = sql.exec('SELECT data, mtime FROM file_chunks WHERE path = ? ORDER BY n', path).toArray();
      if (!rows.length) return undefined;
      return { data: rows.map((r) => String(r.data)).join(''), mtime: Math.max(...rows.map((r) => Number(r.mtime))) };
    },
    put(path, data, mtime) {
      sql.exec('DELETE FROM file_chunks WHERE path = ?', path);
      insert(path, splitText(data, max), 0, mtime);
    },
    append(path, data, mtime) {
      const last = sql.exec('SELECT n, data, len FROM file_chunks WHERE path = ? ORDER BY n DESC LIMIT 1', path).toArray()[0];
      if (!last) return store.put(path, data, mtime);
      const n = Number(last.n);
      const len = Number(last.len);
      if (len + data.length <= max) {
        sql.exec('UPDATE file_chunks SET data = data || ?, len = len + ?, mtime = ? WHERE path = ? AND n = ?', data, data.length, mtime, path, n);
        return;
      }
      // Too long for the last row: rewrite that row full and put the rest in new rows.
      const pieces = splitText(String(last.data) + data, max);
      sql.exec('UPDATE file_chunks SET data = ?, len = ?, mtime = ? WHERE path = ? AND n = ?', pieces[0], pieces[0].length, mtime, path, n);
      insert(path, pieces.slice(1), n + 1, mtime);
    },
    delete(path) {
      sql.exec('DELETE FROM file_chunks WHERE path = ?', path);
    },
    list(prefix) {
      return sql.exec('SELECT DISTINCT path FROM file_chunks WHERE substr(path, 1, ?) = ?', prefix.length, prefix).toArray().map((r) => String(r.path));
    },
  };
  return store;
}

export function memoryFileStore(): SyncFileStore {
  const files = new Map<string, FileRow>();
  return {
    get: (p) => files.get(p),
    put: (p, data, mtime) => void files.set(p, { data, mtime }),
    append: (p, data, mtime) => void files.set(p, { data: (files.get(p)?.data ?? '') + data, mtime }),
    delete: (p) => void files.delete(p),
    list: (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)),
  };
}

let durable: SyncFileStore = memoryFileStore();
const scratch = memoryFileStore();

/** Called once by the Durable Object to put files in its database. */
export function useFileStore(store: SyncFileStore): void {
  durable = store;
}

const norm = (p: unknown) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
const isScratch = (p: string) => p.endsWith('.lock') || p.endsWith('.tmp');
const storeFor = (p: string) => (isScratch(p) ? scratch : durable);

function fail(code: string, p: string): Error {
  const e = new Error(`${code}: ${p}`) as Error & { code: string };
  e.code = code;
  return e;
}

const asText = (data: unknown): string => (typeof data === 'string' ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data));

export function existsSync(p: unknown): boolean {
  const path = norm(p);
  if (storeFor(path).get(path)) return true;
  // a folder exists when anything is in it
  return durable.list(path.endsWith('/') ? path : `${path}/`).length > 0 || path === '/' || path === '/data';
}

export function mkdirSync(): void {
  // folders are implied by file paths
}

export function readFileSync(p: unknown): string {
  const path = norm(p);
  const row = storeFor(path).get(path);
  if (!row) throw fail('ENOENT', path);
  return row.data;
}

export function writeFileSync(p: unknown, data: unknown): void {
  const path = norm(p);
  storeFor(path).put(path, asText(data), Date.now());
}

export function appendFileSync(p: unknown, data: unknown): void {
  const path = norm(p);
  storeFor(path).append(path, asText(data), Date.now());
}

export function renameSync(from: unknown, to: unknown): void {
  const a = norm(from);
  const b = norm(to);
  const row = storeFor(a).get(a);
  if (!row) throw fail('ENOENT', a);
  storeFor(b).put(b, row.data, Date.now());
  storeFor(a).delete(a);
}

export function unlinkSync(p: unknown): void {
  const path = norm(p);
  const store = storeFor(path);
  if (!store.get(path)) throw fail('ENOENT', path);
  store.delete(path);
}

export function rmSync(p: unknown, opts?: { recursive?: boolean; force?: boolean }): void {
  const path = norm(p);
  storeFor(path).delete(path);
  if (opts?.recursive) for (const k of durable.list(`${path}/`)) durable.delete(k);
}

const fds = new Map<number, string>();
let nextFd = 10;

export function openSync(p: unknown, flags?: string): number {
  const path = norm(p);
  const store = storeFor(path);
  if (flags === 'wx' && store.get(path)) throw fail('EEXIST', path);
  store.put(path, '', Date.now());
  const fd = nextFd++;
  fds.set(fd, path);
  return fd;
}

export function writeSync(fd: number, data: unknown): void {
  const path = fds.get(fd);
  if (!path) throw fail('EBADF', String(fd));
  storeFor(path).append(path, asText(data), Date.now());
}

export function closeSync(fd: number): void {
  fds.delete(fd);
}

export function statSync(p: unknown): { mtimeMs: number; isFile(): boolean; isDirectory(): boolean } {
  const path = norm(p);
  const row = storeFor(path).get(path);
  if (!row) throw fail('ENOENT', path);
  return { mtimeMs: row.mtime, isFile: () => true, isDirectory: () => false };
}

export function readdirSync(p: unknown): string[] {
  const path = norm(p).replace(/\/$/, '');
  const names = new Set<string>();
  for (const k of durable.list(`${path}/`)) names.add(k.slice(path.length + 1).split('/')[0]);
  return [...names];
}

export default { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, rmSync, openSync, writeSync, closeSync, statSync, readdirSync };
