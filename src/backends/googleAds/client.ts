import type { FetchLike, TokenSource } from './auth.js';
import { GoogleAdsApiError, parseApiError } from './errors.js';
import { digits } from './settings.js';
import { sleep as realSleep } from '../../util/fsx.js';

/**
 * A small client for the Google Ads API REST interface.
 * https://googleads.googleapis.com/{version}/customers/{id}/...
 *
 * Since September 2026 access belongs to the Google Cloud project, so no
 * developer token is needed. One can still be sent for older setups.
 */

export interface GoogleAdsClientOptions {
  auth: TokenSource;
  apiVersion: string;
  /** Manager account the robot signs in through. Sent as login-customer-id. */
  loginCustomerId?: string;
  developerToken?: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface MutateResponse {
  results: Array<{ resourceName?: string }>;
}

/** login-customer-id for one call: a customer ID, or null to send none. Omit to use the client's default. */
export interface CallOptions {
  login?: string | null;
}

const loginOf = (opts: CallOptions): string | null | undefined => (opts.login === undefined ? undefined : opts.login === null ? null : digits(opts.login));

/** Google did not process the request: safe to retry anything. */
const RETRY_ALWAYS = new Set([429, 503]);
/** Might have been processed: retry reads only, never writes. */
const RETRY_READS = new Set([500, 502, 504]);

export class GoogleAdsClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly opts: GoogleAdsClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.baseUrl = (opts.baseUrl ?? 'https://googleads.googleapis.com').replace(/\/$/, '');
    this.wait = opts.sleep ?? realSleep;
  }

  get apiVersion(): string {
    return this.opts.apiVersion;
  }

  get robotEmail(): string {
    return this.opts.auth.email;
  }

  /** Runs a Google Ads Query Language search and returns every row (pages through results). */
  async search<T = Record<string, any>>(customerId: string, query: string, opts: CallOptions = {}): Promise<T[]> {
    const rows: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 100; page++) {
      const body: Record<string, unknown> = { query: query.replace(/\s+/g, ' ').trim() };
      if (pageToken) body.page_token = pageToken;
      const res = (await this.request('POST', `customers/${digits(customerId)}/googleAds:search`, body, loginOf(opts), true)) as { results?: T[]; nextPageToken?: string };
      rows.push(...(res.results ?? []));
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return rows;
  }

  /**
   * Sends create, update or remove operations for one resource type, for
   * example mutate(id, 'campaignBudgets', [...]). With validateOnly Google
   * checks everything and writes nothing.
   */
  async mutate(customerId: string, resource: string, operations: unknown[], opts: { validateOnly?: boolean } & CallOptions = {}): Promise<MutateResponse> {
    const body: Record<string, unknown> = { operations };
    if (opts.validateOnly) body.validateOnly = true;
    const res = (await this.request('POST', `customers/${digits(customerId)}/${resource}:mutate`, body, loginOf(opts))) as Partial<MutateResponse>;
    return { results: res.results ?? [] };
  }

  /** Creates a client account under a manager account. Returns its 10-digit ID. */
  async createCustomerClient(managerId: string, client: { descriptiveName: string; currencyCode: string; timeZone: string }): Promise<string> {
    const res = (await this.request('POST', `customers/${digits(managerId)}:createCustomerClient`, { customerClient: client }, digits(managerId))) as { resourceName?: string };
    const id = res.resourceName?.split('/').pop();
    if (!id) throw new GoogleAdsApiError('Google did not return the new account ID.', 200, []);
    return id;
  }

  /** Accounts the robot was added to directly (not the ones under them). 10-digit IDs. */
  async listAccessibleCustomers(): Promise<string[]> {
    const res = (await this.request('GET', 'customers:listAccessibleCustomers', undefined, null, true)) as { resourceNames?: string[] };
    return (res.resourceNames ?? []).map((r) => r.split('/').pop() ?? '').filter(Boolean);
  }

  /**
   * @param login login-customer-id override. null sends none.
   * @param read true for searches: these may be retried after a dropped connection. Writes never are, so nothing is created twice.
   */
  private async request(method: 'GET' | 'POST', path: string, body?: unknown, login?: string | null, read = false): Promise<unknown> {
    const url = `${this.baseUrl}/${this.opts.apiVersion}/${path}`;
    const loginId = login === null ? undefined : (login ?? (this.opts.loginCustomerId ? digits(this.opts.loginCustomerId) : undefined));
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await this.opts.auth.accessToken()}`,
        accept: 'application/json',
      };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (loginId) headers['login-customer-id'] = loginId;
      if (this.opts.developerToken) headers['developer-token'] = this.opts.developerToken;

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 45_000),
        });
      } catch (e) {
        if (read && attempt < 2) {
          await this.wait(1500 * (attempt + 1));
          continue;
        }
        throw e;
      }
      const text = await res.text();
      if (res.ok) {
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          throw new GoogleAdsApiError('Google returned a reply that is not JSON.', res.status, []);
        }
      }
      if ((RETRY_ALWAYS.has(res.status) || (read && RETRY_READS.has(res.status))) && attempt < 2) {
        await this.wait(2000 * (attempt + 1));
        continue;
      }
      throw parseApiError(res.status, text);
    }
  }
}
