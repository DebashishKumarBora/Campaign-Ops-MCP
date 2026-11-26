import { readJson, writeJsonAtomic } from '../util/fsx.js';
import { completeSettings } from './settings.js';
import type { AutopilotSettings, FeedItem, Notice, OutcomeState, PageState, ReviewWork } from './types.js';

export interface AutopilotFile {
  version: 1;
  settings: AutopilotSettings;
  seq: number;
  /** Newest last. */
  feed: FeedItem[];
  /** Alerts already sent, so the same problem is not reported every hour. Key to ISO time. */
  sent: Record<string, string>;
  /** Account ID to the local day (YYYY-MM-DD) of its last daily review. */
  reviewed: Record<string, string>;
  lastWatch?: string;
  pages: Record<string, PageState>;
  /** Proposal ID to the result check a week after it was applied. */
  outcomes: Record<string, OutcomeState>;
  /** Notifications held back during quiet hours. */
  held: Notice[];
  /** Reviews in progress, by account ID. */
  work: Record<string, ReviewWork>;
  /** Free AI calls today, so one day can never use up the free allowance. */
  ai: { day: string; calls: number };
  /** Things not to propose for a while that no proposal records, for example a search the AI judged could be a renter. */
  memory: Record<string, { until: string; why: string }>;
  /** When "Check now" was last used. */
  manualAt?: string;
}

const FEED_MAX = 150;
const SENT_DAYS = 21;
const HELD_MAX = 30;

function empty(): AutopilotFile {
  return { version: 1, settings: completeSettings(undefined), seq: 0, feed: [], sent: {}, reviewed: {}, pages: {}, outcomes: {}, held: [], work: {}, ai: { day: '', calls: 0 }, memory: {} };
}

/**
 * Autopilot's memory: one JSON file next to the proposals. Every change is a
 * synchronous load, edit and save, so two steps running close together (a
 * console request and a scheduled check) cannot overwrite each other.
 */
export class AutopilotStore {
  constructor(
    private readonly file: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  load(): AutopilotFile {
    const data = readJson<Partial<AutopilotFile> | null>(this.file, null);
    const base = empty();
    if (!data || data.version !== 1) return base;
    return {
      ...base,
      ...data,
      settings: completeSettings(data.settings),
      feed: Array.isArray(data.feed) ? data.feed : [],
      sent: data.sent ?? {},
      reviewed: data.reviewed ?? {},
      pages: data.pages ?? {},
      outcomes: data.outcomes ?? {},
      held: Array.isArray(data.held) ? data.held : [],
      work: data.work ?? {},
      ai: data.ai ?? { day: '', calls: 0 },
      memory: data.memory ?? {},
    };
  }

  /** Load, change and save in one synchronous step. */
  update<T>(fn: (f: AutopilotFile) => T): T {
    const f = this.load();
    const out = fn(f);
    this.trim(f);
    writeJsonAtomic(this.file, f);
    return out;
  }

  private trim(f: AutopilotFile): void {
    if (f.feed.length > FEED_MAX) f.feed = f.feed.slice(-FEED_MAX);
    if (f.held.length > HELD_MAX) f.held = f.held.slice(-HELD_MAX);
    const cutoff = this.clock() - SENT_DAYS * 86_400_000;
    for (const [k, at] of Object.entries(f.sent)) if (Date.parse(at) < cutoff) delete f.sent[k];
    const now = this.clock();
    for (const [k, v] of Object.entries(f.memory)) if (Date.parse(v.until) <= now) delete f.memory[k];
    const pages = Object.values(f.pages);
    if (pages.length > 60) {
      for (const p of pages.sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt)).slice(0, pages.length - 60)) delete f.pages[p.url];
    }
    const outcomes = Object.entries(f.outcomes);
    if (outcomes.length > 300) {
      for (const [id] of outcomes.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(0, outcomes.length - 300)) delete f.outcomes[id];
    }
  }

  /** Adds a feed item and returns it. Call inside update(). */
  static push(f: AutopilotFile, item: Omit<FeedItem, 'id'>): FeedItem {
    f.seq += 1;
    const full: FeedItem = { id: `F-${f.seq}`, ...item };
    f.feed.push(full);
    return full;
  }
}
