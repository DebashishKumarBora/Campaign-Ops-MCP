import { UserError } from '../../types.js';

/**
 * An error from the Google Ads API, with Google's error codes kept so the
 * tools can explain the problem in plain words.
 */
export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: string[],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'GoogleAdsApiError';
  }

  has(code: string): boolean {
    return this.codes.includes(code);
  }
}

/** A setup problem on this computer (missing key file, refused login). Safe to show as is. */
export class GoogleAdsSetupError extends UserError {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(fix ? `${message} ${fix}` : message);
    this.name = 'GoogleAdsSetupError';
  }
}

interface RawGoogleError {
  code?: number;
  message?: string;
  status?: string;
  details?: Array<Record<string, unknown>>;
}

/** Turns a Google Ads REST error body into a GoogleAdsApiError. */
export function parseApiError(status: number, body: string): GoogleAdsApiError {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  const holder = Array.isArray(json) ? json[0] : json;
  const err = (holder && typeof holder === 'object' ? (holder as { error?: RawGoogleError }).error : undefined) ?? undefined;
  const codes: string[] = [];
  const messages: string[] = [];
  let requestId: string | undefined;

  for (const d of err?.details ?? []) {
    const type = String(d['@type'] ?? '');
    const errors = d.errors as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(errors)) {
      if (typeof d.requestId === 'string') requestId = d.requestId;
      for (const e of errors) {
        const errorCode = e.errorCode as Record<string, unknown> | undefined;
        if (errorCode) for (const v of Object.values(errorCode)) if (typeof v === 'string') codes.push(v);
        if (typeof e.message === 'string') messages.push(e.message);
      }
    }
    if (type.endsWith('ErrorInfo') && typeof d.reason === 'string') codes.push(d.reason);
  }
  if (err?.status && !codes.includes(err.status)) codes.push(err.status);
  const message = messages.length ? messages.join(' ') : err?.message || `Google Ads returned HTTP ${status}.`;
  return new GoogleAdsApiError(message, status, codes, requestId);
}

const FIXES: Array<[string, string]> = [
  ['CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', 'This is a real (production) Google Ads account. Your Google Cloud project only has Test access, so Google only lets it work with test accounts.'],
  ['NOT_ADS_USER', 'The robot is not a user of any Google Ads account yet. In Google Ads, open Admin, then Access and security, then Users, click +, and add the robot email with Standard access.'],
  ['USER_PERMISSION_DENIED', 'The robot cannot reach this account through the manager account. Check that the robot email is added under Admin, then Access and security, in the manager account.'],
  ['CUSTOMER_NOT_FOUND', 'Google cannot find that account. A brand-new account can take a few minutes to appear.'],
  ['CUSTOMER_NOT_ENABLED', 'That account is not active yet, or it was cancelled.'],
  ['SERVICE_DISABLED', 'The Google Ads API is not switched on for the Cloud project. In Google Cloud, search for Google Ads API and click Enable.'],
  ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'The robot login was created without Google Ads access. This is a bug in Campaign Ops; please report it.'],
  ['ACTION_NOT_PERMITTED', 'The robot\'s access level does not allow this. In Google Ads, open Admin, then Access and security, then Users, and change the robot to Admin access.'],
];

/** Plain-English explanation for an error from Google, with a fix when we know one. */
export function explain(e: unknown): string {
  if (e instanceof GoogleAdsApiError) {
    const fix = FIXES.find(([code]) => e.has(code))?.[1];
    const disabled = /has not been used in project|it is disabled/i.test(e.message) ? FIXES.find(([c]) => c === 'SERVICE_DISABLED')![1] : undefined;
    const ref = e.requestId ? ` (Google request ID ${e.requestId})` : '';
    return `Google Ads said: ${e.message}${ref}${fix || disabled ? ` ${fix ?? disabled}` : ''}`;
  }
  if (e instanceof UserError) return e.message;
  const msg = (e as Error)?.message ?? String(e);
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|aborted|timeout/i.test(msg)) {
    return `Could not reach Google (${msg}). Check the internet connection and try again.`;
  }
  return msg;
}
