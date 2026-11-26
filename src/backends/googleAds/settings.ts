import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../util/fsx.js';

/**
 * Where the Google Ads connection lives on this computer.
 *
 * Everything sits in one folder outside the project (by default
 * ~/campaign-ops-secrets), so the key can never be committed to GitHub:
 *   google-ads-key.json   the robot (service account) key. Secret.
 *   google-ads.json       connection settings written by npm run gads:setup. Not secret.
 */

export const DEFAULT_API_VERSION = 'v26';

export interface GoogleAdsAccountSetting {
  /** Customer ID with dashes, for example 123-456-7890. */
  id: string;
  name: string;
  currency: string;
  timezone: string;
  /** What Google reported when the account was checked. Re-checked before every change. */
  testAccount: boolean;
  /**
   * The account the robot signs in through for this account (login-customer-id).
   * Defaults to the manager account. Set to the account itself when the robot
   * was added to it directly.
   */
  loginCustomerId?: string;
}

export interface GoogleAdsSettings {
  keyFile: string;
  /** The manager account the robot signs in through, with dashes. */
  managerId: string;
  apiVersion: string;
  accounts: GoogleAdsAccountSetting[];
  updatedAt?: string;
}

type Env = NodeJS.ProcessEnv;

export function secretsDir(env: Env = process.env): string {
  const custom = env.CAMPAIGN_OPS_SECRETS_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), 'campaign-ops-secrets');
}

export function settingsFile(env: Env = process.env): string {
  return path.join(secretsDir(env), 'google-ads.json');
}

export function defaultKeyFile(env: Env = process.env): string {
  const custom = env.GOOGLE_ADS_KEY_FILE?.trim();
  return custom ? path.resolve(custom) : path.join(secretsDir(env), 'google-ads-key.json');
}

/** 724-800-0350, 7248000350 or "724 800 0350" all become 7248000350. */
export function digits(id: string): string {
  return String(id ?? '').replace(/\D/g, '');
}

export function isCustomerId(id: string): boolean {
  return /^\d{10}$/.test(digits(id));
}

/** 7248000350 becomes 724-800-0350. */
export function dashed(id: string): string {
  const d = digits(id);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d;
}

export function loadSettings(env: Env = process.env): GoogleAdsSettings | null {
  const file = settingsFile(env);
  if (!fs.existsSync(file)) return null;
  return normalizeSettings(readJson<Partial<GoogleAdsSettings> | null>(file, null), env);
}

/** Cleans a google-ads.json object. Used for the file on this computer and for the copy stored as a cloud secret. */
export function normalizeSettings(raw: Partial<GoogleAdsSettings> | null, env: Env = process.env): GoogleAdsSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    keyFile: typeof raw.keyFile === 'string' && raw.keyFile ? raw.keyFile : defaultKeyFile(env),
    managerId: typeof raw.managerId === 'string' ? dashed(raw.managerId) : '',
    apiVersion: typeof raw.apiVersion === 'string' && /^v\d+$/.test(raw.apiVersion) ? raw.apiVersion : DEFAULT_API_VERSION,
    accounts: Array.isArray(raw.accounts)
      ? raw.accounts
          .filter((a): a is GoogleAdsAccountSetting => Boolean(a) && typeof a.id === 'string' && isCustomerId(a.id))
          .map((a) => ({
            id: dashed(a.id),
            name: String(a.name || dashed(a.id)),
            currency: String(a.currency || 'USD'),
            timezone: String(a.timezone || 'America/Chicago'),
            testAccount: Boolean(a.testAccount),
            ...(typeof a.loginCustomerId === 'string' && isCustomerId(a.loginCustomerId) ? { loginCustomerId: dashed(a.loginCustomerId) } : {}),
          }))
      : [],
    updatedAt: raw.updatedAt,
  };
}

export function saveSettings(settings: GoogleAdsSettings, env: Env = process.env): string {
  const file = settingsFile(env);
  writeJsonAtomic(file, {
    $note: 'Written by npm run gads:setup. Not secret. The secret is the key file it points to. Never share or upload that file.',
    ...settings,
    managerId: dashed(settings.managerId),
    accounts: settings.accounts.map((a) => ({ ...a, id: dashed(a.id), ...(a.loginCustomerId ? { loginCustomerId: dashed(a.loginCustomerId) } : {}) })),
    updatedAt: new Date().toISOString(),
  });
  return file;
}
