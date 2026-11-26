/**
 * An in-memory stand-in for the Google Ads REST API and Google's token
 * endpoint, used by the tests and by the script tests over real HTTP.
 * It follows the real formats where Campaign Ops depends on them:
 * camelCase JSON, int64 values as strings, proto3 omitting zero and false
 * values, snake_case update masks, validateOnly, GoogleAdsFailure errors,
 * login-customer-id rules, the Cloud project access level (Test or Explorer),
 * daily metrics, search terms and the change_event history.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServiceAccountKey } from '../src/backends/googleAds/auth.js';
import { localInZone } from '../src/util/time.js';

export interface FakeCustomer {
  id: string;
  name: string;
  testAccount: boolean;
  manager: boolean;
  parent?: string;
  status: string;
  currency: string;
  timeZone: string;
  /** Number of reads that fail with CUSTOMER_NOT_FOUND, like a just-created account. */
  notReadyReads?: number;
}

interface Budget { id: string; name: string; amountMicros: number; removed?: boolean }
interface Camp { id: string; name: string; status: string; channel: string; budget: string; eu?: string }
interface AdGroup { id: string; name: string; campaignId: string }
interface Ad { id: string; adGroupId: string; status: string; headlines: string[]; descriptions: string[]; finalUrls: string[] }
interface Crit { id: string; campaignId: string; text: string; matchType: string; negative: boolean; removed?: boolean }

export interface FakeDay { date: string; impressions: number; clicks: number; cost: number; conversions: number; lostIs?: number }
export interface FakeTerm { campaignId: string; adGroupId: string; term: string; impressions: number; clicks: number; cost: number; conversions: number }

export interface FakeChangeEvent {
  at: number;
  userEmail: string;
  clientType: string;
  resourceType: string;
  resourceName: string;
  operation: 'CREATE' | 'UPDATE' | 'REMOVE';
  changedFields: string;
  campaignId?: string;
  oldResource?: Record<string, unknown>;
  newResource?: Record<string, unknown>;
}

interface Account {
  budgets: Map<string, Budget>;
  campaigns: Map<string, Camp>;
  adGroups: Map<string, AdGroup>;
  ads: Map<string, Ad>;
  keywords: Array<{ adGroupId: string; text: string; matchType: string }>;
  criteria: Map<string, Crit>;
  metrics: Map<string, FakeDay[]>;
  terms: FakeTerm[];
  events: FakeChangeEvent[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status: number; body: unknown };

const failure = (status: number, code: Record<string, string>, message: string): Reply => ({
  status,
  body: {
    error: {
      code: status,
      message: status === 403 ? 'The caller does not have permission' : 'Request contains an invalid argument.',
      status: status === 403 ? 'PERMISSION_DENIED' : status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure', errors: [{ errorCode: code, message }], requestId: 'fake-request-1' }],
    },
  },
});

/** proto3 JSON leaves out zero values; int64 values travel as strings. */
const int64 = (n: number) => (n ? String(Math.round(n)) : undefined);
const dbl = (n: number) => (n ? n : undefined);
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export class FakeGoogleAds {
  readonly requests: RecordedRequest[] = [];
  readonly customers = new Map<string, FakeCustomer>();
  readonly accounts = new Map<string, Account>();
  accessible: string[] = [];
  /** Customer IDs that behave like real (production) accounts even if marked as test. */
  readonly production = new Set<string>();
  /** The Cloud project's API access level. Test access cannot touch production accounts. */
  accessLevel: 'test' | 'explorer' = 'test';
  /** Queue of replies to send instead of the normal one, for error tests. */
  readonly injected: Reply[] = [];
  pageSize = 10_000;
  tokenRequests = 0;
  baseUrl = 'https://googleads.googleapis.com';
  tokenUrl = 'https://oauth2.googleapis.com/token';
  /** Clock for change_event times. */
  now: () => number = () => Date.now();
  private seq = 1000;
  private readonly keys: { privateKey: string; publicKey: crypto.KeyObject };

  constructor() {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.keys = { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKey: pair.publicKey };
  }

  get robotEmail(): string {
    return 'campaign-ops-agent@campaign-ops-test.iam.gserviceaccount.com';
  }

  serviceAccountKey(): ServiceAccountKey {
    return {
      type: 'service_account',
      project_id: 'campaign-ops-test',
      private_key_id: 'key-1',
      private_key: this.keys.privateKey,
      client_email: this.robotEmail,
      token_uri: this.tokenUrl,
    };
  }

  addCustomer(c: Partial<FakeCustomer> & { id: string; name: string }): FakeCustomer {
    const full: FakeCustomer = { testAccount: true, manager: false, status: 'ENABLED', currency: 'USD', timeZone: 'America/Chicago', ...c };
    this.customers.set(c.id, full);
    this.accounts.set(c.id, { budgets: new Map(), campaigns: new Map(), adGroups: new Map(), ads: new Map(), keywords: [], criteria: new Map(), metrics: new Map(), terms: [], events: [] });
    return full;
  }

  account(id: string): Account {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`no fake account ${id}`);
    return a;
  }

  mutations(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.includes(':mutate'));
  }

  /** Real (not validate-only) writes. */
  writes(): RecordedRequest[] {
    return this.mutations().filter((r) => r.body?.validateOnly !== true);
  }

  setDailyMetrics(customerId: string, campaignId: string, days: FakeDay[]): void {
    this.account(customerId).metrics.set(campaignId, days);
  }

  addSearchTerm(customerId: string, term: FakeTerm): void {
    this.account(customerId).terms.push(term);
  }

  /** A change made outside the robot: a person in the web UI, Google Ads Editor, or Google itself. */
  addEvent(customerId: string, e: Partial<FakeChangeEvent> & { resourceType: string; resourceName: string }): void {
    this.account(customerId).events.push({ at: this.now(), userEmail: 'sam@example.com', clientType: 'GOOGLE_ADS_WEB_CLIENT', operation: 'UPDATE', changedFields: '', ...e });
  }

  private nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  /** fetch replacement for unit tests. */
  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach((v, k) => (headers[k] = v));
    const reply = this.handle(init?.method ?? 'GET', url, headers, typeof init?.body === 'string' ? init.body : '');
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };

  /** Serves the same API over real HTTP on 127.0.0.1, for testing the npm scripts. */
  async listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        const reply = this.handle(req.method ?? 'GET', `${this.baseUrl}${req.url}`, headers, body);
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    this.baseUrl = url;
    this.tokenUrl = `${url}/token`;
    return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  handle(method: string, url: string, headers: Record<string, string>, bodyText: string): Reply {
    const u = new URL(url);
    let body: any = undefined;
    if (bodyText) {
      try {
        body = bodyText.startsWith('{') ? JSON.parse(bodyText) : Object.fromEntries(new URLSearchParams(bodyText));
      } catch {
        body = bodyText;
      }
    }
    this.requests.push({ method, path: u.pathname, headers, body });

    if (u.pathname === '/token' || u.href === this.tokenUrl || u.hostname === 'oauth2.googleapis.com') return this.token(body);

    if (headers.authorization !== 'Bearer fake-access-token') return { status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } };
    const injected = this.injected.shift();
    if (injected) return injected;

    const m = u.pathname.match(/^\/(v\d+)\/(.+)$/);
    if (!m) return { status: 404, body: { error: { code: 404, message: 'Not found' } } };
    const path = m[2];

    if (path === 'customers:listAccessibleCustomers' && method === 'GET') {
      return { status: 200, body: { resourceNames: this.accessible.map((id) => `customers/${id}`) } };
    }
    const create = path.match(/^customers\/(\d+):createCustomerClient$/);
    if (create) return this.createClient(create[1], body, headers);
    const search = path.match(/^customers\/(\d+)\/googleAds:search$/);
    if (search) return this.search(search[1], body?.query ?? '', body?.page_token, headers);
    const mutate = path.match(/^customers\/(\d+)\/(\w+):mutate$/);
    if (mutate) return this.mutate(mutate[1], mutate[2], body ?? {}, headers);
    return { status: 404, body: { error: { code: 404, message: `Unknown path ${path}` } } };
  }

  private token(body: any): Reply {
    this.tokenRequests += 1;
    const assertion = String(body?.assertion ?? '');
    const [h, c, s] = assertion.split('.');
    const valid = h && c && s && crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(this.keys.publicKey, Buffer.from(s, 'base64url'));
    const claims = valid ? JSON.parse(Buffer.from(c, 'base64url').toString()) : {};
    if (!valid || body?.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || claims.scope !== 'https://www.googleapis.com/auth/adwords') {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
    }
    return { status: 200, body: { access_token: 'fake-access-token', expires_in: 3599, token_type: 'Bearer' } };
  }

  /** login-customer-id must be an account the robot was added to, and the customer itself or a manager above it. */
  private loginAllowed(customerId: string, headers: Record<string, string>): boolean {
    const login = headers['login-customer-id'] || customerId;
    if (!this.accessible.includes(login)) return false;
    let cur: string | undefined = customerId;
    for (let i = 0; cur && i < 10; i++) {
      if (cur === login) return true;
      cur = this.customers.get(cur)?.parent;
    }
    return false;
  }

  private guard(customerId: string, headers: Record<string, string>): Reply | undefined {
    const c = this.customers.get(customerId);
    if (!c) return failure(400, { requestError: 'CUSTOMER_NOT_FOUND' }, 'The customer was not found.');
    if ((this.production.has(customerId) || !c.testAccount) && this.accessLevel === 'test') {
      return failure(403, { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' }, 'The Google Cloud project is not approved to access production accounts.');
    }
    if (!this.loginAllowed(customerId, headers)) {
      return failure(403, { authorizationError: 'USER_PERMISSION_DENIED' }, "User doesn't have permission to access customer. If you are accessing a client customer, set the manager's customer id in the login-customer-id header.");
    }
    if (c.notReadyReads && c.notReadyReads > 0) {
      c.notReadyReads -= 1;
      return failure(400, { requestError: 'CUSTOMER_NOT_FOUND' }, 'The customer was not found.');
    }
    return undefined;
  }

  private createClient(managerId: string, body: any, headers: Record<string, string>): Reply {
    const g = this.guard(managerId, headers);
    if (g) return g;
    const mgr = this.customers.get(managerId)!;
    const cc = body?.customerClient ?? {};
    const id = String(9_000_000_000 + this.seq++);
    this.addCustomer({ id, name: cc.descriptiveName, testAccount: mgr.testAccount, parent: managerId, currency: cc.currencyCode, timeZone: cc.timeZone, notReadyReads: 1 });
    return { status: 200, body: { resourceName: `customers/${id}` } };
  }

  private campaignOfBudget(a: Account, budgetRn: string): string | undefined {
    return [...a.campaigns.values()].find((c) => c.budget === budgetRn && c.status !== 'REMOVED')?.id;
  }

  private search(customerId: string, query: string, pageToken: string | undefined, headers: Record<string, string>): Reply {
    const g = this.guard(customerId, headers);
    if (g) return g;
    const q = query.replace(/\s+/g, ' ');
    const from = q.match(/ FROM (\w+)/)?.[1];
    const eq = (field: string) => q.match(new RegExp(`${field.replace(/\./g, '\\.')} = (\\d+)`))?.[1];
    const between = q.match(/segments\.date BETWEEN '(\d{4}-\d{2}-\d{2})' AND '(\d{4}-\d{2}-\d{2})'/);
    const a = this.account(customerId);
    const c = this.customers.get(customerId)!;
    let rows: any[] = [];

    if (from === 'customer' && q.includes('metrics.')) {
      // account totals, as used by npm run gads:add (DURING LAST_30_DAYS)
      const end = new Date(this.now());
      const start = new Date(this.now() - 30 * 86_400_000);
      const inRange = (d: string) => d >= start.toISOString().slice(0, 10) && d < end.toISOString().slice(0, 10);
      let cost = 0;
      let clicks = 0;
      let conversions = 0;
      for (const days of a.metrics.values()) {
        for (const d of days) {
          if (!inRange(d.date)) continue;
          cost += d.cost;
          clicks += d.clicks;
          conversions += d.conversions;
        }
      }
      rows = [{ customer: { resourceName: `customers/${c.id}` }, metrics: clean({ costMicros: int64(cost * 1_000_000), clicks: int64(clicks), conversions: dbl(conversions) }) }];
    } else if (from === 'customer') {
      rows = [{ customer: { resourceName: `customers/${c.id}`, id: c.id, descriptiveName: c.name, currencyCode: c.currency, timeZone: c.timeZone, status: c.status, ...(c.testAccount ? { testAccount: true } : {}), ...(c.manager ? { manager: true } : {}) } }];
    } else if (from === 'customer_client') {
      const only = eq('customer_client.id');
      rows = [...this.customers.values()]
        .filter((x) => x.parent === customerId && (!only || x.id === only))
        .map((x) => ({ customerClient: { resourceName: `customers/${customerId}/customerClients/${x.id}`, id: x.id, descriptiveName: x.name, status: x.status, level: '1', ...(x.testAccount ? { testAccount: true } : {}), ...(x.manager ? { manager: true } : {}) } }));
    } else if (from === 'campaign' && q.includes('segments.date')) {
      if (!between) return failure(400, { queryError: 'EXPECTED_FILTERS_ON_DATE_RANGE' }, 'Fake expects a BETWEEN date filter.');
      const [, start, end] = between;
      for (const k of a.campaigns.values()) {
        if (k.status === 'REMOVED') continue;
        for (const d of a.metrics.get(k.id) ?? []) {
          if (d.date < start || d.date > end) continue;
          // Google returns no row for a day with no activity
          if (!d.impressions && !d.clicks && !d.cost && !d.conversions) continue;
          rows.push({
            campaign: { resourceName: `customers/${customerId}/campaigns/${k.id}`, id: k.id, advertisingChannelType: k.channel },
            segments: { date: d.date },
            metrics: clean({ impressions: int64(d.impressions), clicks: int64(d.clicks), costMicros: int64(d.cost * 1_000_000), conversions: dbl(d.conversions), searchBudgetLostImpressionShare: dbl(d.lostIs ?? 0) }),
          });
        }
      }
    } else if (from === 'campaign') {
      const id = eq('campaign.id');
      rows = [...a.campaigns.values()]
        .filter((k) => k.status !== 'REMOVED' && (!id || k.id === id))
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((k) => {
          const b = a.budgets.get(k.budget)!;
          const refs = [...a.campaigns.values()].filter((o) => o.budget === k.budget && o.status !== 'REMOVED').length;
          return {
            campaign: { resourceName: `customers/${customerId}/campaigns/${k.id}`, id: k.id, name: k.name, status: k.status, advertisingChannelType: k.channel },
            campaignBudget: { resourceName: k.budget, amountMicros: String(b.amountMicros), referenceCount: String(refs) },
          };
        });
    } else if (from === 'search_term_view') {
      const cid = eq('campaign.id');
      rows = a.terms
        .filter((t) => (!cid || t.campaignId === cid) && t.cost > 0)
        .sort((x, y) => y.cost - x.cost)
        .map((t) => ({
          searchTermView: { resourceName: `customers/${customerId}/searchTermViews/${t.campaignId}~${t.adGroupId}~x`, searchTerm: t.term },
          campaign: { resourceName: `customers/${customerId}/campaigns/${t.campaignId}`, id: t.campaignId },
          metrics: clean({ impressions: int64(t.impressions), clicks: int64(t.clicks), costMicros: int64(t.cost * 1_000_000), conversions: dbl(t.conversions) }),
        }));
    } else if (from === 'change_event') {
      if (!/ LIMIT \d+/.test(q)) return failure(400, { queryError: 'LIMIT_REQUIRED' }, 'change_event queries need a LIMIT.');
      const range = q.match(/change_event\.change_date_time >= '([^']+)' AND change_event\.change_date_time <= '([^']+)'/);
      if (!range) return failure(400, { queryError: 'EXPECTED_FILTERS_ON_DATE_RANGE' }, 'change_event queries need a date range.');
      const oldest = localInZone(this.now() - 30 * 86_400_000, c.timeZone);
      if (range[1] < oldest) return failure(400, { changeEventError: 'START_DATE_TOO_OLD' }, 'The start date is more than 30 days ago.');
      rows = a.events
        .map((e) => ({ e, local: `${localInZone(e.at, c.timeZone)}.${String(e.at % 1000).padStart(3, '0')}123` }))
        .filter(({ local }) => local >= range[1] && local <= `${range[2]}.999999`)
        .sort((x, y) => y.e.at - x.e.at)
        .map(({ e, local }) => ({
          changeEvent: clean({
            resourceName: `customers/${customerId}/changeEvents/${e.at}~x`,
            changeDateTime: local,
            changeResourceType: e.resourceType,
            changeResourceName: e.resourceName,
            clientType: e.clientType,
            userEmail: e.userEmail,
            resourceChangeOperation: e.operation,
            changedFields: e.changedFields || undefined,
            campaign: e.campaignId ? `customers/${customerId}/campaigns/${e.campaignId}` : undefined,
            oldResource: e.oldResource,
            newResource: e.newResource,
          }),
        }));
    } else if (from === 'ad_group_ad') {
      const cid = eq('campaign.id');
      const adId = eq('ad_group_ad.ad.id');
      rows = [...a.ads.values()]
        .filter((ad) => ad.status !== 'REMOVED')
        .map((ad) => ({ ad, group: a.adGroups.get(ad.adGroupId)! }))
        .filter(({ ad, group }) => (!cid || group.campaignId === cid) && (!adId || ad.id === adId) && a.campaigns.get(group.campaignId)?.status !== 'REMOVED')
        .map(({ ad, group }) => ({
          adGroupAd: {
            resourceName: `customers/${customerId}/adGroupAds/${group.id}~${ad.id}`,
            status: ad.status,
            ad: { resourceName: `customers/${customerId}/ads/${ad.id}`, id: ad.id, finalUrls: ad.finalUrls, responsiveSearchAd: { headlines: ad.headlines.map((text) => ({ text })), descriptions: ad.descriptions.map((text) => ({ text })) } },
          },
          adGroup: { resourceName: `customers/${customerId}/adGroups/${group.id}`, id: group.id, name: group.name },
          campaign: { resourceName: `customers/${customerId}/campaigns/${group.campaignId}`, id: group.campaignId },
        }));
    } else if (from === 'campaign_criterion') {
      const cid = eq('campaign.id');
      rows = [...a.criteria.values()]
        .filter((k) => !k.removed && k.negative && (!cid || k.campaignId === cid))
        .map((k) => ({ campaignCriterion: { resourceName: `customers/${customerId}/campaignCriteria/${k.campaignId}~${k.id}`, status: 'ENABLED', negative: true, keyword: { text: k.text, matchType: k.matchType } } }));
    } else {
      return failure(400, { queryError: 'UNRECOGNIZED_FIELD' }, `Fake does not understand: ${q}`);
    }
    const start = pageToken ? Number(pageToken) : 0;
    const page = rows.slice(start, start + this.pageSize);
    const next = start + this.pageSize < rows.length ? String(start + this.pageSize) : undefined;
    return { status: 200, body: { results: page, fieldMask: 'fake', ...(next ? { nextPageToken: next } : {}) } };
  }

  private mutate(customerId: string, resource: string, body: any, headers: Record<string, string>): Reply {
    const g = this.guard(customerId, headers);
    if (g) return g;
    const a = this.account(customerId);
    const validateOnly = body.validateOnly === true;
    const ops: any[] = body.operations ?? [];
    const prefix = `customers/${customerId}`;
    const results: Array<{ resourceName: string }> = [];
    const apply: Array<() => void> = [];
    const bad = (msg: string, code: Record<string, string> = { fieldError: 'INVALID_VALUE' }) => failure(400, code, msg);
    const robot = (e: Omit<FakeChangeEvent, 'at' | 'userEmail' | 'clientType'>) => apply.push(() => a.events.push({ at: this.now(), userEmail: this.robotEmail, clientType: 'GOOGLE_ADS_API', ...e }));

    for (const op of ops) {
      if (resource === 'campaignBudgets') {
        if (op.create) {
          if (!op.create.name || !/^\d+$/.test(String(op.create.amountMicros))) return bad('Budget needs a name and amountMicros.');
          if (Number(op.create.amountMicros) % 10_000 !== 0) return bad('Budget amount must be a multiple of the minimum currency unit.', { campaignBudgetError: 'NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT' });
          const id = this.nextId();
          const rn = `${prefix}/campaignBudgets/${id}`;
          results.push({ resourceName: rn });
          apply.push(() => a.budgets.set(rn, { id, name: op.create.name, amountMicros: Number(op.create.amountMicros) }));
          robot({ resourceType: 'CAMPAIGN_BUDGET', resourceName: rn, operation: 'CREATE', changedFields: 'name,amountMicros', newResource: { campaignBudget: { amountMicros: String(op.create.amountMicros) } } });
        } else if (op.update) {
          if (op.updateMask !== 'amount_micros') return bad(`Unexpected update mask ${op.updateMask}`);
          const b = a.budgets.get(op.update.resourceName);
          if (!b) return bad('Budget not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
          if (Number(op.update.amountMicros) % 10_000 !== 0) return bad('Budget amount must be a multiple of the minimum currency unit.', { campaignBudgetError: 'NON_MULTIPLE_OF_MINIMUM_CURRENCY_UNIT' });
          results.push({ resourceName: op.update.resourceName });
          const old = b.amountMicros;
          apply.push(() => (b.amountMicros = Number(op.update.amountMicros)));
          robot({ resourceType: 'CAMPAIGN_BUDGET', resourceName: op.update.resourceName, operation: 'UPDATE', changedFields: 'amountMicros', campaignId: this.campaignOfBudget(a, op.update.resourceName), oldResource: { campaignBudget: { amountMicros: String(old) } }, newResource: { campaignBudget: { amountMicros: String(op.update.amountMicros) } } });
        } else return bad('Unsupported budget operation.');
      } else if (resource === 'campaigns') {
        if (op.create) {
          const k = op.create;
          if (!a.budgets.has(k.campaignBudget)) return bad('Budget not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
          if (!k.containsEuPoliticalAdvertising) return bad('Declare EU political advertising.', { campaignError: 'MISSING_EU_POLITICAL_ADVERTISING_SELF_DECLARATION' });
          if ([...a.campaigns.values()].some((x) => x.name === k.name && x.status !== 'REMOVED')) return bad('Duplicate campaign name.', { campaignError: 'DUPLICATE_CAMPAIGN_NAME' });
          const id = this.nextId();
          results.push({ resourceName: `${prefix}/campaigns/${id}` });
          apply.push(() => a.campaigns.set(id, { id, name: k.name, status: k.status, channel: k.advertisingChannelType, budget: k.campaignBudget, eu: k.containsEuPoliticalAdvertising }));
          robot({ resourceType: 'CAMPAIGN', resourceName: `${prefix}/campaigns/${id}`, operation: 'CREATE', changedFields: 'name,status', campaignId: id, newResource: { campaign: { name: k.name, status: k.status } } });
        } else if (op.update) {
          if (op.updateMask !== 'status') return bad(`Unexpected update mask ${op.updateMask}`);
          const id = String(op.update.resourceName).split('/').pop()!;
          const k = a.campaigns.get(id);
          if (!k) return bad('Campaign not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
          results.push({ resourceName: op.update.resourceName });
          const old = k.status;
          apply.push(() => (k.status = op.update.status));
          robot({ resourceType: 'CAMPAIGN', resourceName: op.update.resourceName, operation: 'UPDATE', changedFields: 'status', campaignId: id, oldResource: { campaign: { status: old } }, newResource: { campaign: { status: op.update.status } } });
        } else if (op.remove) {
          const id = String(op.remove).split('/').pop()!;
          const k = a.campaigns.get(id);
          if (!k) return bad('Campaign not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
          results.push({ resourceName: op.remove });
          apply.push(() => (k.status = 'REMOVED'));
          robot({ resourceType: 'CAMPAIGN', resourceName: op.remove, operation: 'REMOVE', changedFields: '', campaignId: id });
        } else return bad('Unsupported campaign operation.');
      } else if (resource === 'adGroups') {
        const k = op.create;
        const cid = String(k?.campaign ?? '').split('/').pop()!;
        if (!a.campaigns.has(cid)) return bad('Campaign not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
        const id = this.nextId();
        results.push({ resourceName: `${prefix}/adGroups/${id}` });
        apply.push(() => a.adGroups.set(id, { id, name: k.name, campaignId: cid }));
        robot({ resourceType: 'AD_GROUP', resourceName: `${prefix}/adGroups/${id}`, operation: 'CREATE', changedFields: 'name', campaignId: cid });
      } else if (resource === 'adGroupCriteria') {
        const k = op.create;
        const gid = String(k?.adGroup ?? '').split('/').pop()!;
        if (!a.adGroups.has(gid) || !k.keyword?.text) return bad('Ad group or keyword missing.');
        const rn = `${prefix}/adGroupCriteria/${gid}~${this.nextId()}`;
        results.push({ resourceName: rn });
        apply.push(() => a.keywords.push({ adGroupId: gid, text: k.keyword.text, matchType: k.keyword.matchType }));
        robot({ resourceType: 'AD_GROUP_CRITERION', resourceName: rn, operation: 'CREATE', changedFields: 'keyword.text', campaignId: a.adGroups.get(gid)!.campaignId });
      } else if (resource === 'adGroupAds') {
        if (op.update) {
          if (op.updateMask !== 'status') return bad(`Unexpected update mask ${op.updateMask}`);
          const m = String(op.update.resourceName ?? '').match(/adGroupAds\/(\d+)~(\d+)$/);
          const ad = m ? a.ads.get(m[2]) : undefined;
          if (!m || !ad || ad.adGroupId !== m[1]) return bad('Ad group ad not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
          if (!['ENABLED', 'PAUSED'].includes(op.update.status)) return bad('Status must be ENABLED or PAUSED.');
          results.push({ resourceName: op.update.resourceName });
          const old = ad.status;
          apply.push(() => (ad.status = op.update.status));
          robot({ resourceType: 'AD_GROUP_AD', resourceName: op.update.resourceName, operation: 'UPDATE', changedFields: 'status', campaignId: a.adGroups.get(ad.adGroupId)!.campaignId, oldResource: { adGroupAd: { status: old } }, newResource: { adGroupAd: { status: op.update.status } } });
          continue;
        }
        const k = op.create;
        const gid = String(k?.adGroup ?? '').split('/').pop()!;
        const rsa = k?.ad?.responsiveSearchAd;
        if (!a.adGroups.has(gid)) return bad('Ad group not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
        if (!rsa || rsa.headlines.length < 3 || rsa.descriptions.length < 2) return bad('A responsive search ad needs 3 headlines and 2 descriptions.', { adError: 'TOO_FEW_HEADLINES' });
        const id = this.nextId();
        results.push({ resourceName: `${prefix}/adGroupAds/${gid}~${id}` });
        apply.push(() => a.ads.set(id, { id, adGroupId: gid, status: k.status, headlines: rsa.headlines.map((h: any) => h.text), descriptions: rsa.descriptions.map((d: any) => d.text), finalUrls: k.ad.finalUrls }));
        robot({ resourceType: 'AD_GROUP_AD', resourceName: `${prefix}/adGroupAds/${gid}~${id}`, operation: 'CREATE', changedFields: 'status,ad', campaignId: a.adGroups.get(gid)!.campaignId });
      } else if (resource === 'campaignCriteria') {
        if (op.create) {
          const k = op.create;
          const cid = String(k.campaign ?? '').split('/').pop()!;
          if (!a.campaigns.has(cid) || k.negative !== true || !k.keyword?.text) return bad('Campaign or keyword missing.');
          if ([...a.criteria.values()].some((x) => !x.removed && x.campaignId === cid && x.text === k.keyword.text && x.matchType === k.keyword.matchType)) {
            return bad('Duplicate negative keyword.', { criterionError: 'CRITERION_ALREADY_EXISTS' });
          }
          const id = this.nextId();
          const rn = `${prefix}/campaignCriteria/${cid}~${id}`;
          results.push({ resourceName: rn });
          apply.push(() => a.criteria.set(id, { id, campaignId: cid, text: k.keyword.text, matchType: k.keyword.matchType, negative: true }));
          robot({ resourceType: 'CAMPAIGN_CRITERION', resourceName: rn, operation: 'CREATE', changedFields: 'keyword.text,keyword.matchType,negative', campaignId: cid, newResource: { campaignCriterion: { negative: true, keyword: { text: k.keyword.text, matchType: k.keyword.matchType } } } });
        } else if (op.remove) {
          const id = String(op.remove).split('~').pop()!;
          const k = a.criteria.get(id);
          if (!k || k.removed) return bad('Criterion not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
          results.push({ resourceName: op.remove });
          apply.push(() => (k.removed = true));
          robot({ resourceType: 'CAMPAIGN_CRITERION', resourceName: op.remove, operation: 'REMOVE', changedFields: '', campaignId: k.campaignId, oldResource: { campaignCriterion: { negative: true, keyword: { text: k.text, matchType: k.matchType } } } });
        } else return bad('Unsupported criterion operation.');
      } else if (resource === 'ads') {
        if (op.updateMask !== 'responsive_search_ad.headlines,responsive_search_ad.descriptions') return bad(`Unexpected update mask ${op.updateMask}`);
        const id = String(op.update?.resourceName ?? '').split('/').pop()!;
        const ad = a.ads.get(id);
        if (!ad) return bad('Ad not found.', { mutateError: 'RESOURCE_NOT_FOUND' });
        const rsa = op.update.responsiveSearchAd;
        results.push({ resourceName: op.update.resourceName });
        apply.push(() => {
          ad.headlines = rsa.headlines.map((h: any) => h.text);
          ad.descriptions = rsa.descriptions.map((d: any) => d.text);
        });
        robot({ resourceType: 'AD', resourceName: op.update.resourceName, operation: 'UPDATE', changedFields: 'responsiveSearchAd.headlines,responsiveSearchAd.descriptions', campaignId: a.adGroups.get(ad.adGroupId)!.campaignId });
      } else {
        return bad(`Fake does not support ${resource}`);
      }
    }
    if (validateOnly) return { status: 200, body: {} };
    for (const fn of apply) fn();
    return { status: 200, body: { results } };
  }
}
