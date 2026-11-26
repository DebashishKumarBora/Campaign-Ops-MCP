/**
 * Shared steps for npm run gads:check and npm run gads:setup.
 * Output is plain words with simple markers so it reads well in Command Prompt.
 */
import { loadConfig } from '../src/config.js';
import { readServiceAccountKey, ServiceAccountAuth } from '../src/backends/googleAds/auth.js';
import { GoogleAdsClient } from '../src/backends/googleAds/client.js';
import { GoogleAdsApiError, explain } from '../src/backends/googleAds/errors.js';
import {
  DEFAULT_API_VERSION,
  dashed,
  defaultKeyFile,
  digits,
  isCustomerId,
  loadSettings,
  saveSettings,
  settingsFile,
  type GoogleAdsSettings,
} from '../src/backends/googleAds/settings.js';

export const say = {
  ok: (m: string) => console.log(`[ OK ] ${m}`),
  info: (m: string) => console.log(`[INFO] ${m}`),
  step: (m: string) => console.log(`[ .. ] ${m}`),
  wait: (m: string) => console.log(`[WAIT] ${m}`),
  warn: (m: string) => console.log(`[WARN] ${m}`),
  line: (m = '') => console.log(m ? `       ${m}` : ''),
  title: (m: string) => console.log(`\n${m}\n${'-'.repeat(m.length)}`),
};

/** A stop with a plain-English reason and what to do about it. */
export class Stop extends Error {
  constructor(
    message: string,
    readonly fix: string[] = [],
  ) {
    super(message);
  }
}

export async function run(main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (e) {
    console.log('');
    if (e instanceof Stop) {
      console.log(`[STOP] ${e.message}`);
      for (const f of e.fix) say.line(f);
    } else {
      console.log(`[STOP] ${explain(e)}`);
    }
    console.log('');
    console.log('Nothing was changed in Google Ads. Fix the step above and run the same command again.');
    process.exitCode = 1;
  }
}

export interface Args {
  managerId?: string;
  fresh: boolean;
}

export function parseArgs(argv: string[]): Args {
  const out: Args = { fresh: false };
  for (const a of argv) {
    if (a === '--fresh') out.fresh = true;
    else if (isCustomerId(a)) out.managerId = dashed(a);
  }
  return out;
}

export interface Connection {
  client: GoogleAdsClient;
  settings: GoogleAdsSettings;
  managerId: string;
  managerName: string;
}

export interface ClientAccount {
  id: string;
  name: string;
  testAccount: boolean;
  manager: boolean;
  status: string;
}

export interface Robot {
  client: GoogleAdsClient;
  email: string;
  keyFile: string;
  apiVersion: string;
  saved: GoogleAdsSettings | null;
}

/** Steps 1 and 2: the key file and the robot login. */
export async function robotLogin(loginCustomerId?: string): Promise<Robot> {
  loadConfig(); // reads .env the same way the server does
  const saved = loadSettings();

  // 1. Key file
  const keyFile = saved?.keyFile && saved.keyFile !== defaultKeyFile() && !process.env.GOOGLE_ADS_KEY_FILE ? saved.keyFile : defaultKeyFile();
  let key;
  try {
    key = readServiceAccountKey(keyFile);
  } catch (e) {
    throw new Stop((e as Error).message);
  }
  say.ok(`Robot key found: ${keyFile}`);
  say.line(`Robot email: ${key.client_email}`);

  // 2. Robot login
  const auth = new ServiceAccountAuth(key);
  try {
    await auth.accessToken();
  } catch (e) {
    throw new Stop(explain(e));
  }
  say.ok('Google accepted the robot login');

  const apiVersion = process.env.GOOGLE_ADS_API_VERSION?.trim() || saved?.apiVersion || DEFAULT_API_VERSION;
  const client = new GoogleAdsClient({
    auth,
    apiVersion,
    loginCustomerId: loginCustomerId || undefined,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined,
    baseUrl: process.env.GOOGLE_ADS_API_BASE_URL?.trim() || undefined, // tests only
  });
  return { client, email: key.client_email, keyFile, apiVersion, saved };
}

/**
 * Steps 1 to 4: key file, robot login, robot added to the manager account,
 * and Google's answer to "is this a test account?". Saves the manager ID.
 */
export async function connect(args: Args): Promise<Connection> {
  loadConfig(); // reads .env the same way the server does
  const savedFirst = loadSettings();
  const managerId = args.managerId ?? (savedFirst?.managerId || (process.env.GOOGLE_ADS_MANAGER_ID ? dashed(process.env.GOOGLE_ADS_MANAGER_ID) : ''));
  if (!isCustomerId(managerId)) {
    throw new Stop('I need your test manager account number (the 10 digits at the top of Google Ads).', ['Run it like this: npm run gads:check -- 724-800-0350']);
  }

  const { client, email, keyFile, apiVersion, saved } = await robotLogin(managerId);
  const key = { client_email: email };

  // 3. Can the robot see the manager account?
  let visible: string[];
  try {
    visible = await client.listAccessibleCustomers();
  } catch (e) {
    throw new Stop(explain(e));
  }
  if (!visible.includes(digits(managerId))) {
    throw new Stop(`The robot cannot see account ${managerId} yet.`, [
      'In Google Ads, open the manager account, then Admin, then Access and security, then Users.',
      `Click +, paste ${key.client_email}, choose Admin access and add it. Setup needs Admin to create the test ad account.`,
      visible.length ? `(The robot can currently see: ${visible.map(dashed).join(', ')})` : '(The robot cannot see any Google Ads account right now.)',
    ]);
  }
  say.ok(`The robot can see account ${managerId}`);

  // 4. Is it a test account? Google answers, not us.
  let row: { customer?: { descriptiveName?: string; testAccount?: boolean; manager?: boolean; status?: string } } | undefined;
  try {
    [row] = await client.search(managerId, 'SELECT customer.id, customer.descriptive_name, customer.test_account, customer.manager, customer.status FROM customer LIMIT 1');
  } catch (e) {
    if (e instanceof GoogleAdsApiError && e.has('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION')) {
      throw new Stop(`Google says ${managerId} is a REAL account, not a test account.`, [
        'Your Cloud project only has Test access, so Google will not let the robot use real accounts. That is the safe setting, so keep it.',
        'Fix: create a test manager account with a different Google login, then run this check again with its number.',
        'Ask Claude for the "second Google login" steps.',
      ]);
    }
    throw new Stop(explain(e));
  }
  const managerName = row?.customer?.descriptiveName || managerId;
  if (!row?.customer?.testAccount) {
    throw new Stop(`Google says ${managerId} "${managerName}" is not a test account.`, ['Campaign Ops only connects to test accounts for now. Create a test manager account and run this check with its number.']);
  }
  if (!row.customer.manager) {
    throw new Stop(`${managerId} "${managerName}" is a test ad account, not a manager account.`, ['Run this with the number of the test MANAGER account (the one you created first).']);
  }
  say.ok(`Google confirms ${managerId} "${managerName}" is a TEST manager account.`);
  say.line('Test accounts never show ads and can never spend money.');

  const settings: GoogleAdsSettings = {
    keyFile,
    managerId,
    apiVersion,
    accounts: saved && digits(saved.managerId) === digits(managerId) ? saved.accounts : [],
  };
  saveSettings(settings);
  return { client, settings, managerId, managerName };
}

export async function listClientAccounts(conn: Connection): Promise<ClientAccount[]> {
  const rows = await conn.client.search<{ customerClient?: { id?: string; descriptiveName?: string; testAccount?: boolean; manager?: boolean; status?: string } }>(
    conn.managerId,
    'SELECT customer_client.id, customer_client.descriptive_name, customer_client.test_account, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level = 1',
  );
  return rows
    .map((r) => r.customerClient)
    .filter((c): c is NonNullable<typeof c> => Boolean(c?.id))
    .map((c) => ({ id: dashed(String(c.id)), name: c.descriptiveName || dashed(String(c.id)), testAccount: Boolean(c.testAccount), manager: Boolean(c.manager), status: c.status ?? 'UNKNOWN' }));
}

export function settingsPath(): string {
  return settingsFile();
}
