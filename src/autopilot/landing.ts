/**
 * Landing page checks. Autopilot opens each page your ads send people to,
 * the way a visitor would. A page counts as down only when the server says
 * so (an error or "not found") or does not answer at all, and only after two
 * checks in a row, so one slow moment never pauses a campaign. Pages that
 * refuse robots (401, 403, 429) are "unsure", never "down".
 */

export interface PageResult {
  status?: number;
  error?: string;
}

export type PageFetcher = (url: string) => Promise<PageResult>;

const TIMEOUT_MS = 12_000;

/** Example and test domains, private addresses and anything that is not a web page are never checked. */
export function skipReason(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a web address';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'not a web page';
  const host = u.hostname.toLowerCase();
  if (/^(.+\.)?example\.(com|org|net)$/.test(host) || /\.(example|invalid|test|localhost|local)$/.test(host) || host === 'localhost') return 'an example address';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return 'a raw IP address';
  return undefined;
}

export function classify(r: PageResult): 'up' | 'down' | 'unsure' {
  if (r.error) return 'down';
  const s = r.status ?? 0;
  if (s >= 200 && s < 400) return 'up';
  if (s === 404 || s === 410 || s >= 500) return 'down';
  return 'unsure';
}

/** Opens a page like a browser would and reads only the status, never the content. */
export const fetchPage: PageFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CampaignOpsPageCheck/0.5)', Accept: 'text/html,application/xhtml+xml' },
    });
    try {
      await res.body?.cancel();
    } catch {
      // the body is not needed
    }
    return { status: res.status };
  } catch (e) {
    return { error: (e as Error).name === 'AbortError' ? 'No answer within 12 seconds' : `Could not connect (${(e as Error).message.slice(0, 80)})` };
  } finally {
    clearTimeout(timer);
  }
};

/** The address without tracking parameters, so one page is checked once. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|gbraid|wbraid|fbclid)/i.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}
