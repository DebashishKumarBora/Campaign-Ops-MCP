/**
 * npm run gads:add -- 123-456-7890            connect a live Google Ads account
 * npm run gads:add -- --remove 123-456-7890   disconnect it
 * npm run gads:add -- --list                  show what is connected
 *
 * A live account is connected READ-ONLY. Campaign Ops reads its real numbers,
 * and nothing can change in it until a person opens a change window in the
 * approval console. Every change still needs its own approval.
 *
 * Before this works, two things must be true:
 *   1. Google has approved your Cloud project for real accounts (Explorer access or higher).
 *   2. The robot email was added as a user to the account, or to a manager account above it.
 */
import { GoogleAdsApiError, explain } from '../src/backends/googleAds/errors.js';
import { dashed, digits, isCustomerId, loadSettings, saveSettings, settingsFile, type GoogleAdsAccountSetting, type GoogleAdsSettings } from '../src/backends/googleAds/settings.js';
import { money } from '../src/util/format.js';
import { robotLogin, run, say, Stop, type Robot } from './gads-common.js';

interface CustomerRow {
  customer?: { id?: string; descriptiveName?: string; currencyCode?: string; timeZone?: string; testAccount?: boolean; manager?: boolean; status?: string };
}
interface ClientRow {
  customerClient?: { id?: string; descriptiveName?: string; manager?: boolean; testAccount?: boolean; status?: string; level?: string | number };
}

const notApproved = (e: unknown) => e instanceof GoogleAdsApiError && e.has('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION');

function explorerPending(id: string): Stop {
  return new Stop(`Google has not approved your Cloud project for real accounts yet, so the robot cannot read ${id}.`, [
    'Real accounts need Explorer access (or higher) on the Google Cloud project that owns the robot.',
    'If you already applied, Google is still reviewing it. When Google confirms the new access level, run this command again.',
    'Nothing else needs to change.',
  ]);
}

function parse(argv: string[]): { id?: string; remove: boolean; list: boolean } {
  const out: { id?: string; remove: boolean; list: boolean } = { remove: false, list: false };
  for (const a of argv) {
    if (a === '--remove') out.remove = true;
    else if (a === '--list') out.list = true;
    else if (isCustomerId(a)) out.id = dashed(a);
  }
  return out;
}

function describe(a: GoogleAdsAccountSetting): string {
  return `${a.id}  ${a.name}  (${a.testAccount ? 'test account' : 'LIVE, read-only until a change window is opened'})`;
}

/** Finds which account the robot should sign in through to reach the target. */
async function findRoute(robot: Robot, target: string): Promise<string> {
  let visible: string[];
  try {
    visible = (await robot.client.listAccessibleCustomers()).map(dashed);
  } catch (e) {
    throw new Stop(explain(e));
  }
  if (visible.includes(target)) {
    say.ok(`The robot was added to ${target} directly`);
    return target;
  }
  let sawUnapproved = false;
  for (const v of visible) {
    try {
      const [me] = await robot.client.search<CustomerRow>(v, 'SELECT customer.id, customer.manager FROM customer LIMIT 1', { login: v });
      if (!me?.customer?.manager) continue;
      const rows = await robot.client.search<ClientRow>(
        v,
        `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.id = ${digits(target)}`,
        { login: v },
      );
      if (rows.some((r) => dashed(String(r.customerClient?.id ?? '')) === target)) {
        say.ok(`The robot can reach ${target} through the manager account ${v}`);
        return v;
      }
    } catch (e) {
      if (notApproved(e)) sawUnapproved = true;
      // a test manager or an account the robot cannot read: keep looking
    }
  }
  if (sawUnapproved) throw explorerPending(target);
  throw new Stop(`The robot cannot see account ${target} yet.`, [
    'In Google Ads, open that account (or a manager account above it), then Admin, then Access and security, then Users.',
    `Click +, paste ${robot.email}, and add it.`,
    'Safest start: choose Read only. Campaign Ops can still read everything, and Google itself blocks every change.',
    'Later, when you want Campaign Ops to make approved changes, switch the robot to Standard.',
    visible.length ? `(The robot can currently see: ${visible.join(', ')})` : '(The robot cannot see any Google Ads account right now.)',
  ]);
}

async function add(target: string): Promise<void> {
  say.title(`Campaign Ops: connect the live Google Ads account ${target}`);
  const robot = await robotLogin();
  const login = await findRoute(robot, target);

  let row: CustomerRow['customer'];
  try {
    [row] = (await robot.client.search<CustomerRow>(
      target,
      'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.test_account, customer.manager, customer.status FROM customer LIMIT 1',
      { login },
    )).map((r) => r.customer);
  } catch (e) {
    if (notApproved(e)) throw explorerPending(target);
    throw new Stop(explain(e));
  }
  if (!row) throw new Stop(`Google returned no details for ${target}.`);
  const name = row.descriptiveName || target;

  if (row.manager) {
    let children: ClientRow['customerClient'][] = [];
    try {
      children = (await robot.client.search<ClientRow>(
        target,
        'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level = 1',
        { login },
      )).map((r) => r.customerClient).filter((c) => c && !c.manager && c.status === 'ENABLED');
    } catch {
      // listing is a convenience only
    }
    throw new Stop(`${target} "${name}" is a manager account. Campaign Ops works on the ad accounts inside it.`, [
      children.length ? 'Ad accounts inside it:' : 'Google listed no active ad accounts inside it.',
      ...children.slice(0, 20).map((c) => `  ${dashed(String(c!.id))}  ${c!.descriptiveName ?? ''}`),
      children.length ? `Run again with one of those numbers, for example: npm run gads:add -- ${dashed(String(children[0]!.id))}` : '',
    ].filter(Boolean));
  }
  if (row.testAccount) {
    throw new Stop(`Google says ${target} "${name}" is a test account.`, ['Test accounts are set up with npm run gads:setup, which also builds the sample campaigns.']);
  }
  if (row.status && row.status !== 'ENABLED') {
    throw new Stop(`${target} "${name}" is ${row.status.toLowerCase()} in Google Ads. Campaign Ops only connects active accounts.`);
  }
  say.ok(`Google confirms ${target} "${name}" is a LIVE ad account (${row.currencyCode ?? 'USD'}, ${row.timeZone ?? 'time zone unknown'})`);

  // A first real read, so you can see the numbers are real.
  try {
    const campaigns = await robot.client.search<{ campaign?: { status?: string } }>(target, "SELECT campaign.id, campaign.status FROM campaign WHERE campaign.status != 'REMOVED'", { login });
    const running = campaigns.filter((c) => c.campaign?.status === 'ENABLED').length;
    const [totals] = await robot.client.search<{ metrics?: { costMicros?: string | number; clicks?: string | number; conversions?: string | number } }>(
      target,
      'SELECT metrics.cost_micros, metrics.clicks, metrics.conversions FROM customer WHERE segments.date DURING LAST_30_DAYS',
      { login },
    );
    const m = totals?.metrics ?? {};
    const cost = Number(m.costMicros ?? 0) / 1_000_000;
    say.ok(`Read ${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} (${running} running)`);
    say.line(`Last 30 days: ${money(cost, row.currencyCode || 'USD')} spent, ${Number(m.clicks ?? 0).toLocaleString('en-US')} clicks, ${Math.round(Number(m.conversions ?? 0)).toLocaleString('en-US')} conversions.`);
  } catch (e) {
    say.warn(`Connected, but the first read of campaigns failed: ${explain(e)}`);
  }

  const account: GoogleAdsAccountSetting = {
    id: target,
    name,
    currency: row.currencyCode || 'USD',
    timezone: row.timeZone || 'America/Chicago',
    testAccount: false,
    loginCustomerId: login,
  };
  const saved = robot.saved;
  const settings: GoogleAdsSettings = saved
    ? { ...saved, accounts: [...saved.accounts.filter((a) => dashed(a.id) !== target), account] }
    : { keyFile: robot.keyFile, managerId: '', apiVersion: robot.apiVersion, accounts: [account] };
  const file = saveSettings(settings);
  say.ok(`Saved the connection: ${file}`);

  console.log('');
  console.log(`Done. "${name}" is connected as a LIVE account.`);
  console.log('');
  console.log('What that means:');
  console.log('  - Campaign Ops reads its real numbers: spend, clicks, leads and search terms.');
  console.log('  - Nothing can change in it until a person opens a change window in the approval console.');
  console.log('  - Even inside a window, every change still needs its own approval.');
  console.log('  - If the robot has Read only access in Google Ads, Google itself also blocks every change.');
  console.log('');
  console.log('Next:');
  console.log('  1. Fully quit Claude Desktop: right-click its icon near the clock, then Quit.');
  console.log('  2. Open Claude Desktop again.');
  console.log(`  3. Ask: "Run a health check on ${name}."`);
  console.log('');
  console.log(`To disconnect it at any time: npm run gads:add -- --remove ${target}`);
}

function remove(target: string): void {
  say.title(`Campaign Ops: disconnect ${target}`);
  const saved = loadSettings();
  const found = saved?.accounts.find((a) => dashed(a.id) === target);
  if (!saved || !found) throw new Stop(`${target} is not connected, so there is nothing to remove.`, [`Connected accounts are listed in ${settingsFile()}`]);
  saveSettings({ ...saved, accounts: saved.accounts.filter((a) => dashed(a.id) !== target) });
  say.ok(`Disconnected ${found.name} (${target}). Campaign Ops will no longer read or change it.`);
  say.line('Quit and reopen Claude Desktop so it picks up the change.');
  say.line('To fully cut access, also remove the robot email from the account in Google Ads (Admin, then Access and security).');
}

function list(): void {
  say.title('Campaign Ops: connected Google Ads accounts');
  const saved = loadSettings();
  if (!saved || saved.accounts.length === 0) {
    say.info('No Google Ads accounts are connected yet.');
    return;
  }
  for (const a of saved.accounts) say.line(describe(a));
}

const args = parse(process.argv.slice(2));
if (args.list) {
  list();
} else {
  await run(async () => {
    if (!args.id) {
      throw new Stop('I need the 10-digit number of the Google Ads account (shown at the top of Google Ads).', [
        'Connect a live account:   npm run gads:add -- 123-456-7890',
        'Disconnect an account:    npm run gads:add -- --remove 123-456-7890',
        'Show what is connected:   npm run gads:add -- --list',
      ]);
    }
    if (args.remove) remove(args.id);
    else await add(args.id);
  });
}
