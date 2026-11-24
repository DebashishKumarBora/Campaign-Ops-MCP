// In-memory replacement for node:fs so the unmodified engine and sandbox run in a browser.
// Only the calls the engine uses are implemented. Everything lives in memory and resets on reload.
const files = new Map();
const dirs = new Set(['/']);
const fds = new Map();
let fdSeq = 10;

const norm = (p) => String(p).replace(/\\/g, '/');
function fail(code, p) {
  const e = new Error(`${code}: ${p}`);
  e.code = code;
  return e;
}

export function reset() { files.clear(); dirs.clear(); dirs.add('/'); fds.clear(); }
export function existsSync(p) { p = norm(p); return files.has(p) || dirs.has(p); }
export function mkdirSync(p) { dirs.add(norm(p)); }
export function readFileSync(p) { p = norm(p); if (!files.has(p)) throw fail('ENOENT', p); return files.get(p); }
export function writeFileSync(p, data) { files.set(norm(p), String(data)); }
export function appendFileSync(p, data) { p = norm(p); files.set(p, (files.get(p) || '') + String(data)); }
export function renameSync(a, b) { a = norm(a); b = norm(b); if (!files.has(a)) throw fail('ENOENT', a); files.set(b, files.get(a)); files.delete(a); }
export function unlinkSync(p) { p = norm(p); if (!files.has(p)) throw fail('ENOENT', p); files.delete(p); }
export function rmSync(p, opts) {
  p = norm(p);
  files.delete(p);
  if (opts && opts.recursive) for (const k of [...files.keys()]) if (k.startsWith(p + '/')) files.delete(k);
  dirs.delete(p);
}
export function openSync(p, flags) {
  p = norm(p);
  if (flags === 'wx' && files.has(p)) throw fail('EEXIST', p);
  files.set(p, '');
  const fd = fdSeq++;
  fds.set(fd, p);
  return fd;
}
export function writeSync(fd, data) { const p = fds.get(fd); files.set(p, (files.get(p) || '') + String(data)); }
export function closeSync(fd) { fds.delete(fd); }
export function statSync(p) { p = norm(p); if (!files.has(p) && !dirs.has(p)) throw fail('ENOENT', p); return { mtimeMs: Date.now() }; }
export function readdirSync() { return []; }

export default { reset, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, rmSync, openSync, writeSync, closeSync, statSync, readdirSync };
