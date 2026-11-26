import type { CampaignOps } from './ops.js';

/** Everything the Worker and its Durable Object get from Cloudflare. Secrets are set by npm run cloud:setup. */
export interface Env {
  OPS: DurableObjectNamespace<CampaignOps>;
  OAUTH_KV: KVNamespace;
  ASSETS: Fetcher;
  /** Signs console session cookies (HMAC). Secret. */
  SESSION_SECRET: string;
  /** One-time setup code for the first passkey: JSON {hash, expiresAt, epoch}. Secret. */
  SETUP_CODE?: string;
  /** Web push sender keys. The public half is not secret; the private half (a JWK) is. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** One-time token that lets the setup script move history from this computer into the cloud. Secret. */
  IMPORT_TOKEN?: string;
  /** The Google Ads robot key (service account JSON) and connection settings. Secrets. */
  GOOGLE_ADS_KEY?: string;
  GOOGLE_ADS_SETTINGS?: string;
  /** Tests only: a fake Google Ads API and plain-http push endpoints on this computer. */
  GOOGLE_ADS_API_BASE_URL?: string;
  ALLOW_INSECURE_TEST_ENDPOINTS?: string;
}
