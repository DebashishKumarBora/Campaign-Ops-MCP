import crypto from 'node:crypto';
import fs from 'node:fs';
import { GoogleAdsSetupError } from './errors.js';

/**
 * Signs in to Google as the robot (a Google Cloud service account) using its
 * JSON key, with no extra libraries: a short-lived JWT signed with the key is
 * exchanged for a one-hour access token. The key never leaves this computer.
 */

export const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ServiceAccountKey {
  type: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  token_uri?: string;
}

export interface TokenSource {
  readonly email: string;
  accessToken(): Promise<string>;
}

export function readServiceAccountKey(file: string): ServiceAccountKey {
  if (!fs.existsSync(file)) {
    throw new GoogleAdsSetupError(`No robot key file at ${file}.`, 'Download the JSON key for the service account in Google Cloud and save it there as google-ads-key.json.');
  }
  let json: Partial<ServiceAccountKey>;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ServiceAccountKey>;
  } catch {
    throw new GoogleAdsSetupError(`The robot key file at ${file} is not valid JSON.`, 'Download a fresh JSON key from Google Cloud (Service accounts, Keys, Add key, JSON).');
  }
  if (json.type !== 'service_account' || typeof json.client_email !== 'string' || typeof json.private_key !== 'string') {
    throw new GoogleAdsSetupError(`The file at ${file} is not a service account key.`, 'It should be the JSON key you downloaded from Google Cloud for campaign-ops-agent.');
  }
  return json as ServiceAccountKey;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** Builds the signed assertion Google exchanges for an access token (RFC 7523). */
export function signJwt(key: ServiceAccountKey, nowMs = Date.now(), scope = ADWORDS_SCOPE): string {
  const iat = Math.floor(nowMs / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (key.private_key_id) header.kid = key.private_key_id;
  const claims = { iss: key.client_email, scope, aud: key.token_uri || TOKEN_URL, iat, exp: iat + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  let signature: Buffer;
  try {
    signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  } catch {
    throw new GoogleAdsSetupError('The robot key file is damaged (its private key cannot be read).', 'Download a fresh JSON key from Google Cloud.');
  }
  return `${unsigned}.${b64url(signature)}`;
}

export class ServiceAccountAuth implements TokenSource {
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  get email(): string {
    return this.key.client_email;
  }

  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.clock()) return this.cached.token;
    // One sign-in at a time, even when several calls start together.
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetchToken(): Promise<string> {
    const assertion = signJwt(this.key, this.clock());
    const res = await this.fetchImpl(this.key.token_uri || TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: { access_token?: string; expires_in?: number; error?: string; error_description?: string } = {};
    try {
      json = JSON.parse(text);
    } catch {
      // keep the empty object; the status explains the failure
    }
    if (!res.ok || !json.access_token) {
      const why = [json.error, json.error_description].filter(Boolean).join(': ') || `HTTP ${res.status}`;
      const clock = /token must be a short-lived|iat|exp|not yet valid/i.test(why) ? ' Check that this computer\'s clock and time zone are set correctly (Windows Settings, Time and language, Set time automatically).' : '';
      throw new GoogleAdsSetupError(`Google refused the robot login (${why}).`, `If you deleted or replaced the key in Google Cloud, download a new one.${clock}`);
    }
    this.cached = { token: json.access_token, expiresAt: this.clock() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }
}
