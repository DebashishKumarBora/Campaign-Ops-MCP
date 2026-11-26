import type { Proposal } from '../types.js';
import { money } from '../util/format.js';

/**
 * A short headline for a proposal, for the feed and notifications: "Block 5
 * wasted searches in Juniper Yard | Search | Generic" instead of the full
 * summary with every keyword. The app writes the same headline.
 */
export function shortTitle(p: Pick<Proposal, 'change' | 'targetLabel' | 'before' | 'rollbackOf' | 'summary'>): string {
  const c = p.change;
  const target = p.targetLabel;
  let h: string;
  switch (c.type) {
    case 'add_negative_keywords':
      h = `Block ${c.keywords.length} wasted ${c.keywords.length === 1 ? 'search' : 'searches'} in ${target}`;
      break;
    case 'remove_negative_keywords':
      h = `Allow ${c.keywords.length} blocked ${c.keywords.length === 1 ? 'search' : 'searches'} again in ${target}`;
      break;
    case 'set_campaign_budget': {
      const before = (p.before as { dailyBudget?: number } | undefined)?.dailyBudget;
      h = `${typeof before === 'number' && c.newDailyBudget < before ? 'Lower' : 'Raise'} ${target} to ${money(c.newDailyBudget)} a day`;
      break;
    }
    case 'set_campaign_status':
      h = `${c.newStatus === 'PAUSED' ? 'Pause' : 'Turn on'} ${target}`;
      break;
    case 'update_ad_text':
      h = `New copy for ad ${c.adId}`;
      break;
    case 'set_ad_status':
      h = `${c.newStatus === 'PAUSED' ? 'Pause' : 'Turn on'} ad ${c.adId}`;
      break;
    default:
      h = p.summary;
  }
  return p.rollbackOf ? `Undo ${p.rollbackOf}: ${h.charAt(0).toLowerCase()}${h.slice(1)}` : h;
}
