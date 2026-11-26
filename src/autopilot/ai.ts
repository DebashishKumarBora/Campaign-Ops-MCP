import type { Policy } from '../types.js';
import { lintAdCopy, normalizeForLint, protectedTermIn } from '../governance/fairHousing.js';
import { normalizeKeyword } from '../util/format.js';

/**
 * The free AI behind Autopilot (Cloudflare Workers AI, included in the free
 * plan). It does three narrow jobs, and every answer is checked by code
 * before anything is proposed:
 *
 *  1. Double-check search terms before they are blocked. The AI can only
 *     take terms off the list, never add one.
 *  2. Rewrite ad lines that failed the Fair Housing screen.
 *  3. Write extra headlines for thin ads.
 *
 * Copy is accepted only if it passes the Fair Housing screen, fits Google's
 * limits and uses only facts already in the ad (no new numbers, offers or
 * amenities). Whatever passes still needs a person's approval.
 */

/** Anything with Workers AI's run(model, input) shape. */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export const DEFAULT_MODELS = ['@cf/google/gemma-4-26b-a4b-it', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];

/** Calls per day at most, far inside the free daily allowance. */
export const AI_DAILY_LIMIT = 40;

const CALL_TIMEOUT_MS = 30_000;

export interface TermsAnswer {
  exclude: string[];
  keep: Array<{ term: string; why: string }>;
}

export interface CopyAnswer {
  headlines: string[];
  descriptions: string[];
  rejected: string[];
}

export interface AiBrain {
  readonly model: string;
  checkTerms(input: { community: string; campaign: string; examples: string[]; terms: string[] }): Promise<TermsAnswer>;
  rewriteLines(input: { community: string; headlines: string[]; descriptions: string[]; flagged: Array<{ field: string; text: string; problem: string }> }): Promise<Array<{ field: string; options: string[] }>>;
  moreCopy(input: { community: string; headlines: string[]; descriptions: string[]; addHeadlines: number; addDescriptions: number }): Promise<{ headlines: string[]; descriptions: string[] }>;
}

// ---------- reading what the model said ----------

/** The text of a Workers AI answer, whichever shape the model uses. */
export function textOf(out: unknown): string {
  if (typeof out === 'string') return out;
  if (!out || typeof out !== 'object') return '';
  const o = out as Record<string, any>;
  if (typeof o.response === 'string') return o.response;
  if (o.response && typeof o.response === 'object') return JSON.stringify(o.response);
  const choice = Array.isArray(o.choices) ? o.choices[0] : undefined;
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
  if (o.result) return textOf(o.result);
  return '';
}

/** Finds the JSON object in a model's answer, even with prose or code fences around it. Tries the last one first. */
export function parseJsonLoose(text: string): unknown {
  const s = String(text ?? '');
  const found: string[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inString) {
        if (c === '\\') j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          found.push(s.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  for (const candidate of found.reverse()) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next one
    }
  }
  return undefined;
}

// ---------- checking copy ----------

/** Words any rental ad may use that state no fact about the home. */
const GENERIC = new Set(
  (
    'tour tours touring book booking schedule visit visiting today online apply call homes home apartment apartments living your with from near this that here there more learn ' +
    'details find discover explore choose available availability leasing lease rent rental rentals ready move moving check start enjoy community communities location located ' +
    'close steps away into what when where every each just also plus than then they their them some welcome come make made take life space spaces room rooms plans plan ' +
    'floor floorplans unit units site official website info information contact questions team office hours open daily week weekend reserve secure application ' +
    'about around inside outside meet residence residences address place places style styled design designed'
  ).split(' '),
);

/** Promises a person approving might not notice: allowed only when the current ad already says them. */
const CLAIMS = ['free', 'discount', 'discounted', 'special', 'specials', 'deal', 'deals', 'offer', 'offers', 'cheapest', 'cheap', 'lowest', 'best', 'guaranteed', 'guarantee', 'waived', 'waive', 'save', 'savings', 'luxury', 'award', 'rated', 'top', 'only', 'exclusive', 'limited', 'hurry', 'last chance', 'number one', 'brand new', 'new construction', 'safe', 'safest', 'quiet'];

const stem = (w: string) => w.replace(/(ies|es|s|ing|ed)$/, '').slice(0, 6);
const words = (text: string) =>
  normalizeForLint(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !GENERIC.has(w));

export interface CopyContext {
  /** Everything the current ad says, plus the community name. */
  source: string;
  /** Lines already in the ad (new lines must differ). */
  existing: string[];
  limits: Policy['adCopy'];
}

/** Checks one line of AI copy. Returns the cleaned line, or why it was refused. */
export function checkLine(raw: string, kind: 'headline' | 'description', ctx: CopyContext): { ok: true; text: string } | { ok: false; why: string } {
  let text = String(raw ?? '')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\s*[\u2013\u2014]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
  if (kind === 'description' && text && !/[.?]$/.test(text) && text.length < ctx.limits.descriptionMaxChars) text = `${text}.`;
  const max = kind === 'headline' ? ctx.limits.headlineMaxChars : ctx.limits.descriptionMaxChars;
  if (!text) return { ok: false, why: 'empty' };
  if (text.length > max) return { ok: false, why: `"${text}" is ${text.length} characters (limit ${max})` };
  if (kind === 'headline' && text.includes('!')) return { ok: false, why: `"${text}" has an exclamation mark` };
  if (/https?:|www\.|\.com\b|@/.test(text.toLowerCase())) return { ok: false, why: `"${text}" contains a web or email address` };
  const lint = lintAdCopy([{ field: kind, text }]);
  if (lint.status !== 'clean') return { ok: false, why: `"${text}" failed the Fair Housing screen (${lint.findings[0]?.match})` };
  const source = normalizeForLint(ctx.source);
  const prot = protectedTermIn(text);
  if (prot && !source.includes(normalizeForLint(prot.term))) return { ok: false, why: `"${text}" mentions ${prot.term}` };
  for (const n of text.match(/\d+/g) ?? []) if (!new RegExp(`(^|\\D)${n}(\\D|$)`).test(ctx.source)) return { ok: false, why: `"${text}" adds the number ${n}, which the current ad does not say` };
  for (const sym of ['$', '%']) if (text.includes(sym) && !ctx.source.includes(sym)) return { ok: false, why: `"${text}" adds a price or percentage` };
  const norm = ` ${normalizeForLint(text).replace(/[^a-z0-9#\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const normSource = ` ${source.replace(/[^a-z0-9#\s]/g, ' ').replace(/\s+/g, ' ')} `;
  for (const claim of CLAIMS) if (norm.includes(` ${claim} `) && !normSource.includes(` ${claim} `)) return { ok: false, why: `"${text}" says "${claim}", which the current ad does not` };
  const known = new Set(words(ctx.source).map(stem));
  for (const w of words(text)) if (!known.has(stem(w))) return { ok: false, why: `"${text}" says "${w}", which the current ad does not` };
  for (const w of text.split(/\s+/)) if (/^[A-Z]{4,}$/.test(w) && !ctx.source.includes(w)) return { ok: false, why: `"${text}" shouts in capitals` };
  const key = normalizeKeyword(text).replace(/[^a-z0-9 ]/g, '');
  if (ctx.existing.some((e) => normalizeKeyword(e).replace(/[^a-z0-9 ]/g, '') === key)) return { ok: false, why: `"${text}" repeats a line already in the ad` };
  return { ok: true, text };
}

/** Accepts up to `want` good lines from the AI's options, in order. */
export function pickLines(options: string[], want: number, kind: 'headline' | 'description', ctx: CopyContext): { lines: string[]; rejected: string[] } {
  const lines: string[] = [];
  const rejected: string[] = [];
  for (const o of options) {
    if (lines.length >= want) break;
    const r = checkLine(o, kind, { ...ctx, existing: [...ctx.existing, ...lines] });
    if (r.ok) lines.push(r.text);
    else rejected.push(r.why);
  }
  return { lines, rejected };
}

// ---------- the Workers AI brain ----------

const RULES = [
  'Follow the U.S. Fair Housing Act. Describe the home, its features and its location, never who should live there.',
  'Never mention families, children, adults, age, singles, couples, students, professionals, retirees, religion, race, national origin, sex, disability, health or how rent is paid.',
  'Use only facts the current ad already states. Add no prices, numbers, offers, awards, amenities or claims that are not in it.',
  `Headlines are at most 30 characters with no exclamation mark. Descriptions are at most 90 characters.`,
  'Answer with JSON only.',
].join(' ');

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The AI took too long to answer.')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const strings = (v: unknown, max = 40): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);

export function workersAiBrain(runner: AiRunner, models: string[] = DEFAULT_MODELS): AiBrain {
  async function ask(system: string, user: unknown, maxTokens: number): Promise<unknown> {
    let lastError: unknown;
    for (const model of models) {
      const input: Record<string, unknown> = {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: typeof user === 'string' ? user : JSON.stringify(user) },
        ],
        temperature: 0.2,
      };
      if (model.includes('gemma-4')) input.max_completion_tokens = maxTokens;
      else input.max_tokens = maxTokens;
      try {
        const out = await withTimeout(runner.run(model, input), CALL_TIMEOUT_MS);
        const parsed = parseJsonLoose(textOf(out));
        if (parsed && typeof parsed === 'object') return parsed;
        lastError = new Error('The AI did not answer in JSON.');
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('The AI did not answer.');
  }

  return {
    model: models[0],

    async checkTerms(input) {
      const system =
        'You review search terms from a Google Ads campaign that rents apartments. For each term decide if the person searching could be looking for a home to rent. ' +
        'Exclude a term only when it clearly is not about renting a home, for example job searches, storage units, cleaning services, furniture, hotels or how-to questions. ' +
        'When unsure, keep it. Never exclude a term because of who might be searching. Answer with JSON only: {"exclude": ["term"], "keep": [{"term": "term", "why": "short reason"}]}';
      const answer = (await ask(system, { community: input.community, campaign: input.campaign, searches_that_bring_leads: input.examples.slice(0, 8), terms_to_review: input.terms }, 900)) as Record<string, unknown>;
      const asked = new Map(input.terms.map((t) => [normalizeKeyword(t), t]));
      const exclude = [...new Set(strings(answer.exclude).map(normalizeKeyword))].filter((t) => asked.has(t)).map((t) => asked.get(t)!);
      const keep: TermsAnswer['keep'] = [];
      for (const k of Array.isArray(answer.keep) ? answer.keep : []) {
        const term = normalizeKeyword(String((k as { term?: unknown })?.term ?? ''));
        if (asked.has(term) && !exclude.includes(asked.get(term)!)) keep.push({ term: asked.get(term)!, why: String((k as { why?: unknown }).why ?? '').slice(0, 160) });
      }
      // A term the AI did not mention stays out of the change: when in doubt, keep.
      for (const t of input.terms) if (!exclude.includes(t) && !keep.some((k) => k.term === t)) keep.push({ term: t, why: 'The AI did not clear it.' });
      return { exclude, keep };
    },

    async rewriteLines(input) {
      const system =
        `You fix lines in a Google Ads responsive search ad for an apartment community. ${RULES} ` +
        'For each line to replace, give two options that keep its meaning without the problem. Answer: {"replacements": [{"field": "Headline 2", "options": ["...", "..."]}]}';
      const answer = (await ask(system, { community: input.community, current_ad: { headlines: input.headlines, descriptions: input.descriptions }, replace: input.flagged }, 900)) as Record<string, unknown>;
      const out: Array<{ field: string; options: string[] }> = [];
      for (const r of Array.isArray(answer.replacements) ? answer.replacements : []) {
        const field = String((r as { field?: unknown })?.field ?? '');
        if (!input.flagged.some((f) => f.field === field)) continue;
        const options = strings((r as { options?: unknown }).options, 4);
        const single = (r as { text?: unknown }).text;
        if (typeof single === 'string') options.unshift(single);
        out.push({ field, options });
      }
      return out;
    },

    async moreCopy(input) {
      const system =
        `You add lines to a Google Ads responsive search ad for an apartment community. ${RULES} ` +
        'Each new line must say something different from the lines already there. Answer: {"headlines": ["..."], "descriptions": ["..."]}';
      const answer = (await ask(
        system,
        { community: input.community, current_ad: { headlines: input.headlines, descriptions: input.descriptions }, add_headlines: input.addHeadlines + 3, add_descriptions: input.addDescriptions ? input.addDescriptions + 1 : 0 },
        900,
      )) as Record<string, unknown>;
      return { headlines: strings(answer.headlines, 12), descriptions: strings(answer.descriptions, 6) };
    },
  };
}

/** Tests only: a Workers AI stand-in reached over HTTP. */
export function httpAiRunner(url: string): AiRunner {
  return {
    async run(model, input) {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }) });
      if (!res.ok) throw new Error(`AI stand-in answered ${res.status}`);
      return res.json();
    },
  };
}
