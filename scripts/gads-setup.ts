/**
 * npm run gads:setup            (add --fresh to rebuild the sample campaigns)
 * Connects Campaign Ops to a Google Ads TEST account:
 *   1. runs every check from gads:check
 *   2. finds or creates the test ad account "Demo Apartments"
 *   3. builds the sample campaigns in it
 *   4. saves the connection so the MCP server and console pick it up
 * It refuses to touch anything Google does not confirm is a test account.
 */
import { GoogleAdsApiError, explain } from '../src/backends/googleAds/errors.js';
import { dashed, saveSettings, type GoogleAdsAccountSetting } from '../src/backends/googleAds/settings.js';
import { seedAccount } from '../src/backends/googleAds/seeder.js';
import { sleep } from '../src/util/fsx.js';
import { createApp } from '../src/app.js';
import { connect, listClientAccounts, parseArgs, run, say, Stop, type Connection } from './gads-common.js';

const ACCOUNT_NAME = 'Demo Apartments';
const CURRENCY = 'USD';
const TIME_ZONE = 'America/Chicago';

interface CustomerRow {
  customer?: { id?: string; descriptiveName?: string; testAccount?: boolean; currencyCode?: string; timeZone?: string };
}

async function readCustomer(conn: Connection, id: string): Promise<CustomerRow['customer']> {
  const [row] = await conn.client.search<CustomerRow>(id, 'SELECT customer.id, customer.descriptive_name, customer.test_account, customer.currency_code, customer.time_zone FROM customer LIMIT 1');
  if (!row?.customer) throw new GoogleAdsApiError('Google returned no details for the account.', 404, ['NOT_FOUND']);
  return row.customer;
}

/** A brand-new account can take a few minutes before Google lets anyone read it. */
async function waitUntilReady(conn: Connection, id: string): Promise<CustomerRow['customer']> {
  const started = Date.now();
  let told = false;
  for (;;) {
    try {
      return await readCustomer(conn, id);
    } catch (e) {
      const waiting = e instanceof GoogleAdsApiError && (e.has('CUSTOMER_NOT_FOUND') || e.has('CUSTOMER_NOT_ENABLED') || e.has('NOT_FOUND'));
      if (!waiting) throw e;
    }
    if (Date.now() - started > 8 * 60_000) {
      throw new Stop(`Google has not finished creating ${id} after 8 minutes.`, ['Wait 10 minutes and run npm run gads:setup again. It will find the account and carry on.']);
    }
    if (!told) {
      say.wait('Google is finishing the new account. This usually takes 1 to 5 minutes. Leave this window open.');
      told = true;
    }
    await sleep(Number(process.env.GOOGLE_ADS_SETUP_POLL_MS) || 15_000);
  }
}

await run(async () => {
  const args = parseArgs(process.argv.slice(2));
  say.title('Campaign Ops: connect a Google Ads test account');
  const conn = await connect(args);

  // Find or create the test ad account.
  const clients = await listClientAccounts(conn);
  const target = clients.find((c) => !c.manager && c.name.trim().toLowerCase() === ACCOUNT_NAME.toLowerCase() && c.status === 'ENABLED');
  let id = '';
  let customer: CustomerRow['customer'];
  if (target) {
    try {
      customer = await readCustomer(conn, target.id);
      id = target.id;
      say.ok(`Found the test ad account ${id} "${target.name}"`);
    } catch (e) {
      if (!(e instanceof GoogleAdsApiError && e.has('CUSTOMER_NOT_ENABLED'))) throw e;
      say.warn(`"${target.name}" (${target.id}) exists but is not active, probably the half-finished one from the billing screen. Making a new one.`);
    }
  }
  if (!id) {
    say.step(`Creating the test ad account "${ACCOUNT_NAME}" inside ${conn.managerId}`);
    try {
      id = dashed(await conn.client.createCustomerClient(conn.managerId, { descriptiveName: ACCOUNT_NAME, currencyCode: CURRENCY, timeZone: TIME_ZONE }));
    } catch (e) {
      if (e instanceof GoogleAdsApiError && (e.has('ACTION_NOT_PERMITTED') || e.has('USER_PERMISSION_DENIED') || e.status === 403)) {
        throw new Stop('Google did not let the robot create the account.', [
          explain(e),
          'Fix: in Google Ads, open Admin, then Access and security, then Users.',
          'Click the robot email and change its access to Admin. Then run npm run gads:setup again.',
        ]);
      }
      throw e;
    }
    say.ok(`Created ${id} "${ACCOUNT_NAME}"`);
    customer = await waitUntilReady(conn, id);
  }

  if (!customer?.testAccount) {
    throw new Stop(`Google says ${id} is not a test account, so Campaign Ops will not touch it.`);
  }
  say.ok(`Google confirms ${id} is a TEST ad account`);

  // Build the sample campaigns.
  say.step(args.fresh ? 'Rebuilding the sample campaigns' : 'Building the sample campaigns');
  const seedFrom = new Date().toISOString();
  const report = await seedAccount(conn.client, id, { fresh: args.fresh, log: (l) => say.line(l) });
  const seedTo = new Date().toISOString();
  if (report.created.length || report.removed.length) {
    // Tell the audit log, so the witness check knows these robot changes were the setup, not a stray use of the key.
    try {
      await createApp().engine.recordSetup({ accountId: id, from: seedFrom, to: seedTo, changes: report.created.length + report.removed.length, by: 'npm run gads:setup' });
    } catch (e) {
      say.warn(`Could not note the setup in the audit log: ${(e as Error).message}`);
    }
  }
  for (const w of report.warnings) say.warn(w);
  if (report.created.length) say.ok(`${report.created.length} campaign${report.created.length === 1 ? '' : 's'} created`);
  if (report.skipped.length && !report.created.length) say.ok('The sample campaigns were already there. Add --fresh to rebuild them.');

  // Save the connection.
  const account: GoogleAdsAccountSetting = {
    id,
    name: customer.descriptiveName || ACCOUNT_NAME,
    currency: customer.currencyCode || CURRENCY,
    timezone: customer.timeZone || TIME_ZONE,
    testAccount: true,
  };
  const accounts = [...conn.settings.accounts.filter((a) => dashed(a.id) !== id), account];
  const file = saveSettings({ ...conn.settings, accounts });
  say.ok(`Saved the connection: ${file}`);

  console.log('');
  console.log('Done. Campaign Ops is connected to your Google Ads test account.');
  console.log('');
  console.log('Next:');
  console.log('  1. Fully quit Claude Desktop: right-click its icon near the clock, then Quit.');
  console.log('  2. Open Claude Desktop again.');
  console.log(`  3. Ask: "List my accounts, then run a health check on ${account.name}."`);
});
