/**
 * Time-zone helpers. Google Ads reports dates and change times in the
 * account's own time zone, so these convert between that and UTC using the
 * built-in Intl API (no extra dependency, works in Node and the browser).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a time zone. Falls back to UTC for an unknown zone. */
export function partsInZone(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter(timeZone).formatToParts(new Date(ms));
  } catch {
    parts = formatter('UTC').formatToParts(new Date(ms));
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, mi: get('minute'), s: get('second') };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** The calendar day of an instant in a time zone, as YYYY-MM-DD. */
export function dayInZone(ms: number, timeZone: string): string {
  const p = partsInZone(ms, timeZone);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

/** "YYYY-MM-DD HH:MM:SS" wall-clock time in a time zone (the format Google Ads queries use). */
export function localInZone(ms: number, timeZone: string): string {
  const p = partsInZone(ms, timeZone);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** Offset of a time zone from UTC at an instant, in milliseconds (positive east of UTC). */
function offsetMs(ms: number, timeZone: string): number {
  const p = partsInZone(ms, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Converts wall-clock time in a time zone ("2026-11-26 05:08:12.123456" or
 * "2026-11-26T05:08:12") to a UTC instant in milliseconds. NaN if unreadable.
 */
export function zonedToUtcMs(local: string, timeZone: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(String(local ?? '').trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = '0', frac = '0'] = m;
  const millis = Math.round(Number(`0.${frac}`) * 1000);
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millis);
  // Two passes settle the offset correctly around daylight-saving changes.
  let utc = guess - offsetMs(guess, timeZone);
  utc = guess - offsetMs(utc, timeZone);
  return utc;
}
