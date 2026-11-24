export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function money(n: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const sign = n < 0 ? '-' : '';
  return `${sign}${symbol}${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(fraction: number, digits = 1): string {
  const value = fraction * 100;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function share(fraction: number, digits = 0): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDay(d);
}

/** Removes control characters and trims, so text from an AI cannot break logs or layouts. */
export function cleanText(text: string, maxLength: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  return stripped.length > maxLength ? stripped.slice(0, maxLength - 1) + '…' : stripped;
}

export function normalizeKeyword(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
