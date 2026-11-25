import type { GoogleAdsClient } from './client.js';
import { explain } from './errors.js';
import { digits } from './settings.js';
import { seedPlan } from './seedPlan.js';

/**
 * Builds the sample campaigns in a Google Ads TEST account.
 * Safe to run again: campaigns that already exist are left alone, unless
 * fresh is set, in which case they are removed and built again.
 * The caller must have confirmed the account is a test account.
 */

export interface SeedReport {
  created: string[];
  skipped: string[];
  removed: string[];
  warnings: string[];
}

const micros = (amount: number): string => String(Math.round(amount * 100) * 10_000);

/** Used if Google refuses the placeholder example.com address. Test ads never show, so nobody visits it. */
const FALLBACK_URL = 'https://debashishkumarbora.github.io/campaign-ops/';

function firstResource(res: { results: Array<{ resourceName?: string }> }, what: string): string {
  const rn = res.results[0]?.resourceName;
  if (!rn) throw new Error(`Google did not return the new ${what}.`);
  return rn;
}

export async function seedAccount(
  client: GoogleAdsClient,
  customerId: string,
  opts: { fresh?: boolean; log?: (line: string) => void } = {},
): Promise<SeedReport> {
  const customer = digits(customerId);
  const log = opts.log ?? (() => undefined);
  const report: SeedReport = { created: [], skipped: [], removed: [], warnings: [] };
  const plan = seedPlan();
  const planned = new Set(plan.map((p) => p.name.toLowerCase()));

  const existing = await client.search<{ campaign?: { id?: string; name?: string; resourceName?: string } }>(
    customer,
    "SELECT campaign.id, campaign.name, campaign.resource_name FROM campaign WHERE campaign.status != 'REMOVED'",
  );
  const present = new Map<string, string>();
  for (const r of existing) {
    if (r.campaign?.name && r.campaign.id) present.set(r.campaign.name.toLowerCase(), r.campaign.resourceName ?? `customers/${customer}/campaigns/${r.campaign.id}`);
  }

  if (opts.fresh) {
    const toRemove = [...present.entries()].filter(([name]) => planned.has(name));
    if (toRemove.length) {
      await client.mutate(customer, 'campaigns', toRemove.map(([, rn]) => ({ remove: rn })));
      for (const [name] of toRemove) {
        present.delete(name);
        report.removed.push(name);
      }
      log(`- Removed ${toRemove.length} earlier sample campaign${toRemove.length === 1 ? '' : 's'}`);
    }
  }

  const stamp = Date.now().toString(36);
  for (const c of plan) {
    if (present.has(c.name.toLowerCase())) {
      report.skipped.push(c.name);
      log(`= ${c.name} (already there)`);
      continue;
    }

    // Budget and campaign: if these fail, stop and explain, because the rest depends on them.
    const budget = firstResource(
      await client.mutate(customer, 'campaignBudgets', [
        { create: { name: `${c.name} budget ${stamp}`, amountMicros: micros(c.dailyBudget), deliveryMethod: 'STANDARD', explicitlyShared: false } },
      ]),
      'budget',
    );
    const campaign: Record<string, unknown> = {
      name: c.name,
      status: 'ENABLED',
      advertisingChannelType: c.channel,
      campaignBudget: budget,
      manualCpc: {},
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    };
    if (c.channel === 'SEARCH') {
      campaign.networkSettings = { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false };
    }
    const campaignRn = firstResource(await client.mutate(customer, 'campaigns', [{ create: campaign }]), 'campaign');

    // Everything below is best effort: a problem becomes a warning, not a stop.
    let keywords = 0;
    let ads = 0;
    let negatives = 0;
    if (c.channel === 'SEARCH' && c.adGroupName) {
      try {
        const adGroup = firstResource(
          await client.mutate(customer, 'adGroups', [
            { create: { name: c.adGroupName, campaign: campaignRn, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: micros(2) } },
          ]),
          'ad group',
        );
        if (c.keywords.length) {
          try {
            await client.mutate(
              customer,
              'adGroupCriteria',
              c.keywords.map((k) => ({ create: { adGroup, status: 'ENABLED', keyword: { text: k.text, matchType: k.matchType } } })),
            );
            keywords = c.keywords.length;
          } catch (e) {
            report.warnings.push(`${c.name}: keywords not added. ${explain(e)}`);
          }
        }
        for (const ad of c.ads) {
          const create = (url: string) =>
            client.mutate(customer, 'adGroupAds', [
              {
                create: {
                  adGroup,
                  status: 'ENABLED',
                  ad: {
                    finalUrls: [url],
                    responsiveSearchAd: { headlines: ad.headlines.map((text) => ({ text })), descriptions: ad.descriptions.map((text) => ({ text })) },
                  },
                },
              },
            ]);
          try {
            try {
              await create(ad.finalUrl);
            } catch (e) {
              if (!/url|destination|domain/i.test(explain(e))) throw e;
              await create(FALLBACK_URL);
            }
            ads++;
          } catch (e) {
            const planted = ad.headlines.includes('Ideal for Young Professionals');
            report.warnings.push(
              planted
                ? `${c.name}: Google's own policy check refused the planted Fair Housing test ad, so the agent will find the other problems only. ${explain(e)}`
                : `${c.name}: an ad was not added. ${explain(e)}`,
            );
          }
        }
      } catch (e) {
        report.warnings.push(`${c.name}: ad group not added. ${explain(e)}`);
      }
    }
    if (c.negatives.length) {
      try {
        await client.mutate(
          customer,
          'campaignCriteria',
          c.negatives.map((n) => ({ create: { campaign: campaignRn, negative: true, keyword: { text: n.text, matchType: n.matchType } } })),
        );
        negatives = c.negatives.length;
      } catch (e) {
        report.warnings.push(`${c.name}: negative keywords not added. ${explain(e)}`);
      }
    }

    report.created.push(c.name);
    const parts = [`$${c.dailyBudget}/day`];
    if (c.channel === 'SEARCH') parts.push(`${keywords} keyword${keywords === 1 ? '' : 's'}`, `${ads} ad${ads === 1 ? '' : 's'}`);
    if (negatives) parts.push(`${negatives} negative keyword${negatives === 1 ? '' : 's'}`);
    log(`+ ${c.name} (${parts.join(', ')})`);
  }
  return report;
}
