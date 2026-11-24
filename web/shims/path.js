// Minimal POSIX path helpers for the in-memory filesystem.
const clean = (p) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
export function join(...parts) { return clean(parts.filter(Boolean).join('/')); }
export function dirname(p) { p = clean(p); const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
export function basename(p) { p = clean(p); return p.slice(p.lastIndexOf('/') + 1); }
export function resolve(...parts) { const j = join(...parts); return j.startsWith('/') ? j : '/' + j; }
export default { join, dirname, basename, resolve, sep: '/' };
