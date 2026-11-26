import { readServiceAccountKey, ServiceAccountAuth } from './auth.js';
import { GoogleAdsBackend } from './backend.js';
import { GoogleAdsClient } from './client.js';
import { loadSettings, settingsFile } from './settings.js';

export { GoogleAdsBackend } from './backend.js';
export { GoogleAdsClient } from './client.js';
export { ServiceAccountAuth, readServiceAccountKey } from './auth.js';

export type GoogleAdsStatus = 'off' | 'not_set_up' | 'ready' | 'error';

const falsy = (v?: string) => ['0', 'false', 'no', 'off'].includes((v ?? '').trim().toLowerCase());

/**
 * Turns on the Google Ads backend when npm run gads:setup has saved a
 * connection. Never throws and never calls Google: the server must start
 * even when the internet is down or the key has a problem.
 */
export function loadGoogleAdsBackend(env: NodeJS.ProcessEnv = process.env): { backend?: GoogleAdsBackend; status: GoogleAdsStatus; message: string } {
  if (falsy(env.CAMPAIGN_OPS_GOOGLE_ADS)) return { status: 'off', message: 'Google Ads connection turned off (CAMPAIGN_OPS_GOOGLE_ADS=off).' };
  let settings;
  try {
    settings = loadSettings(env);
  } catch (e) {
    return { status: 'error', message: `Google Ads settings could not be read: ${(e as Error).message}` };
  }
  if (!settings || settings.accounts.length === 0) {
    return { status: 'not_set_up', message: `Google Ads not connected (no accounts in ${settingsFile(env)}). Run npm run gads:setup to connect a test account.` };
  }
  try {
    const key = readServiceAccountKey(settings.keyFile);
    const client = new GoogleAdsClient({
      auth: new ServiceAccountAuth(key),
      apiVersion: env.GOOGLE_ADS_API_VERSION?.trim() || settings.apiVersion,
      loginCustomerId: settings.managerId || undefined,
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined,
      baseUrl: env.GOOGLE_ADS_API_BASE_URL?.trim() || undefined, // tests only
    });
    const backend = new GoogleAdsBackend({ settings, client });
    return {
      backend,
      status: 'ready',
      message: `Google Ads connected: ${settings.accounts.map((a) => `${a.name} (${a.id}, ${a.testAccount ? 'test' : 'live, read-only until a change window is opened'})`).join(', ')}.`,
    };
  } catch (e) {
    return { status: 'error', message: `Google Ads not connected: ${(e as Error).message}` };
  }
}
