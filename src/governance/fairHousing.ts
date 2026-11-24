import type { FairHousingFinding, FairHousingReport } from '../types.js';

/**
 * Fair Housing screening for ad copy and negative keywords.
 *
 * Section 804(c) of the Fair Housing Act prohibits housing ads that state a
 * preference, limitation or discrimination based on race, color, religion,
 * sex, disability, familial status or national origin. Many states and cities
 * add more protections, such as source of income. These rules flag common
 * risk patterns so a person looks before anything ships.
 *
 * This is a screening aid. It is not legal advice and it cannot prove that
 * copy is compliant.
 */

export const FAIR_HOUSING_DISCLAIMER = 'Screening aid only. It flags common risk patterns and is not legal advice.';

type Category =
  | 'familial_status'
  | 'disability'
  | 'race_color_national_origin'
  | 'religion'
  | 'sex'
  | 'source_of_income'
  | 'age'
  | 'steering_language'
  | 'military_status';

interface Rule {
  id: string;
  category: Category;
  severity: 'block' | 'warn';
  re: RegExp;
  message: string;
  suggestion: string;
}

const MSG = {
  familial: 'States a preference about families with children. Housing ads cannot limit or prefer by familial status.',
  familialTip: 'Describe the home and its amenities instead of who should live there.',
  disability: 'Excludes or limits people with disabilities.',
  disabilityTip: 'Describe the property (for example "third-floor walk-up"). Listing accessibility features is fine.',
  race: 'Describes residents or neighbors by race, color, national origin or language.',
  raceTip: 'Describe the property and the location, not the people.',
  religion: 'States a religious preference.',
  religionTip: 'Naming a nearby place of worship as a landmark is fine. Describing residents by religion is not.',
  sex: 'States a preference based on sex.',
  sexTip: 'Remove the restriction.',
  sogi: 'Excludes people by sexual orientation or gender identity, which many states and cities protect.',
  income: 'Refuses a lawful source of income, such as housing vouchers, which many states and cities protect.',
  incomeTip: 'Remove it, or state your actual screening criteria.',
  age: 'Signals an age preference and can discourage families with children.',
  ageTip: 'Describe amenities instead (for example "coworking lounge" or "steps from nightlife").',
  steering: 'Words like these have a history as coded steering language.',
  steeringTip: 'Point to concrete features instead, such as controlled access or private balconies.',
};

const RULES: Rule[] = [
  // Familial status
  { id: 'fs-adults-only', category: 'familial_status', severity: 'block', re: /\b(adults?|grown ?ups?)\s+only\b/, message: MSG.familial, suggestion: MSG.familialTip },
  { id: 'fs-no-children', category: 'familial_status', severity: 'block', re: /\bno\s+(kids|children|child|minors|teens|teenagers|babies|infants|toddlers)\b(?!')/, message: MSG.familial, suggestion: MSG.familialTip },
  { id: 'fs-children-not-allowed', category: 'familial_status', severity: 'block', re: /\b(kids|children|minors)\s+(are\s+)?not\s+(allowed|permitted|welcome|accepted)\b/, message: MSG.familial, suggestion: MSG.familialTip },
  { id: 'fs-adult-community', category: 'familial_status', severity: 'block', re: /\badult\s+(community|building|complex|living|tenants|residents|lifestyle)\b/, message: MSG.familial, suggestion: 'If this is qualified 55+ housing, say "55+ community". Otherwise remove it.' },
  { id: 'fs-singles-couples', category: 'familial_status', severity: 'block', re: /\b(perfect|ideal|great|best|suited|suitable|made)\s+for\s+(a\s+)?(singles?|couples?|single\s+(people|persons|professionals|adults)|newlyweds|bachelors?)\b/, message: MSG.familial, suggestion: MSG.familialTip },
  { id: 'fs-child-free', category: 'familial_status', severity: 'block', re: /\b(child|kid)\s+free\b/, message: MSG.familial, suggestion: MSG.familialTip },
  { id: 'fs-child-limit', category: 'familial_status', severity: 'block', re: /\b(max(imum)?\s+(of\s+)?(one|two|1|2)|only\s+(one|1))\s+(child|children|kid|kids)\b/, message: MSG.familial, suggestion: MSG.familialTip },
  { id: 'fs-no-pregnant', category: 'familial_status', severity: 'block', re: /\bno\s+(pregnant|expecting)\b/, message: MSG.familial, suggestion: MSG.familialTip },

  // Disability
  { id: 'dis-no-wheelchairs', category: 'disability', severity: 'block', re: /\bno\s+(wheelchairs?|disabled|handicapped|handicaps)\b/, message: MSG.disability, suggestion: MSG.disabilityTip },
  { id: 'dis-able-bodied', category: 'disability', severity: 'block', re: /\b(able bodied|physically fit (tenants|residents|applicants|only))\b/, message: MSG.disability, suggestion: MSG.disabilityTip },
  { id: 'dis-must-be-able', category: 'disability', severity: 'block', re: /\bmust\s+be\s+able\s+to\s+(walk|climb|use\s+(the\s+)?stairs|see|hear)\b/, message: MSG.disability, suggestion: MSG.disabilityTip },
  { id: 'dis-no-assistance-animals', category: 'disability', severity: 'block', re: /\bno\s+(service|support|assistance|therapy|emotional\s+support)\s+(animals?|dogs?|pets?)\b/, message: 'Refuses assistance animals, which can deny a reasonable accommodation for a disability.', suggestion: 'Remove it. If you have a pet policy, add "assistance animals welcome".' },
  { id: 'dis-not-suitable', category: 'disability', severity: 'block', re: /\bnot\s+(suitable|suited|appropriate)\s+for\s+(the\s+)?(disabled|handicapped|people\s+with\s+disabilities|wheelchair\s+users)\b/, message: MSG.disability, suggestion: MSG.disabilityTip },
  { id: 'dis-mental', category: 'disability', severity: 'block', re: /\bno\s+(mentally\s+ill|mental\s+illness|psychiatric\s+(patients|conditions))\b/, message: MSG.disability, suggestion: MSG.disabilityTip },

  // Race, color, national origin, language
  { id: 'race-people', category: 'race_color_national_origin', severity: 'block', re: /\b(white|black|caucasian|asian|hispanic|latino|latina|latinx|african|arab|mexican|chinese|european|anglo|indian)\s+(neighborhood|neighbourhood|community|area|building|family|families|tenants|residents|people|block|only)\b/, message: MSG.race, suggestion: MSG.raceTip },
  { id: 'nat-english-only', category: 'race_color_national_origin', severity: 'block', re: /\b(english|english speaking|english speakers?)\s+only\b|\bmust\s+speak\s+(fluent\s+)?english\b/, message: MSG.race, suggestion: MSG.raceTip },
  { id: 'nat-no-immigrants', category: 'race_color_national_origin', severity: 'block', re: /\bno\s+(immigrants|foreigners|refugees|international\s+(students|tenants|applicants))\b/, message: MSG.race, suggestion: MSG.raceTip },
  { id: 'nat-citizens-only', category: 'race_color_national_origin', severity: 'warn', re: /\b(us|u\.s\.|american)\s+citizens?\s+only\b/, message: 'Citizenship-only language can read as national origin discrimination.', suggestion: 'Have a compliance reviewer confirm the requirement and the wording.' },

  // Religion
  { id: 'rel-people', category: 'religion', severity: 'block', re: /\b(christian|catholic|jewish|muslim|islamic|hindu|buddhist|mormon|protestant|evangelical|sikh)\s+(home|homes|community|building|neighborhood|neighbourhood|family|families|tenants|residents|only|people|living)\b/, message: MSG.religion, suggestion: MSG.religionTip },
  { id: 'rel-no-group', category: 'religion', severity: 'block', re: /\bno\s+(christians|catholics|jews|muslims|hindus|buddhists|mormons|atheists|sikhs)\b/, message: MSG.religion, suggestion: MSG.religionTip },

  // Sex, sexual orientation, gender identity
  { id: 'sex-only', category: 'sex', severity: 'block', re: /\b(male|female|males|females|men|women|ladies|gentlemen|guys|girls|boys)\s+only\b/, message: MSG.sex, suggestion: MSG.sexTip },
  { id: 'sex-no-group', category: 'sex', severity: 'block', re: /\bno\s+(men|women|males|females|guys|girls)\b/, message: MSG.sex, suggestion: MSG.sexTip },
  { id: 'sogi-exclude', category: 'sex', severity: 'block', re: /\bno\s+(gays?|lesbians?|lgbtq?|trans|transgender)\b|\b(straight|heterosexual)\s+only\b/, message: MSG.sogi, suggestion: MSG.sexTip },

  // Source of income
  { id: 'soi-no-vouchers', category: 'source_of_income', severity: 'block', re: /\bno\s+(section\s*8|vouchers?|housing\s+choice\s+vouchers?|hcv|government\s+assistance|public\s+assistance|subsid(y|ies)|welfare|ssi|ssdi)\b/, message: MSG.income, suggestion: MSG.incomeTip },
  { id: 'soi-not-accepted', category: 'source_of_income', severity: 'block', re: /\b(section\s*8|vouchers?)\s+(not\s+(accepted|welcome|allowed)|need\s+not\s+apply)\b/, message: MSG.income, suggestion: MSG.incomeTip },
  { id: 'soi-employed', category: 'source_of_income', severity: 'warn', re: /\bmust\s+be\s+(employed|working)\b/, message: 'Employment-only wording can exclude people with lawful income from benefits or retirement.', suggestion: 'State an income requirement instead of an employment requirement.' },

  // Age signals (warn)
  { id: 'age-young', category: 'age', severity: 'warn', re: /\b(young|youthful)\s+(professionals?|people|crowd|singles|tenants|residents|community|adults)\b/, message: MSG.age, suggestion: MSG.ageTip },
  { id: 'age-perfect-for', category: 'age', severity: 'warn', re: /\b(perfect|ideal|great|best|made)\s+for\s+(students|college\s+students|grad(uate)?\s+students|millennials|gen\s*z|retirees|seniors)\b/, message: MSG.age, suggestion: MSG.ageTip },
  { id: 'age-empty-nesters', category: 'age', severity: 'warn', re: /\bempty\s+nesters?\b/, message: MSG.age, suggestion: MSG.ageTip },
  { id: 'age-mature', category: 'age', severity: 'warn', re: /\bmature\s+(person|persons|individuals?|adults?|tenants?|residents?|community)\b/, message: MSG.age, suggestion: MSG.ageTip },

  // Steering language (warn)
  { id: 'st-exclusive', category: 'steering_language', severity: 'warn', re: /\b(exclusive|restricted|private)\s+(community|neighborhood|neighbourhood|enclave|area|building)\b/, message: MSG.steering, suggestion: MSG.steeringTip },
  { id: 'st-residents', category: 'steering_language', severity: 'warn', re: /\b(integrated|traditional|ethnic|diverse|homogeneous)\s+(neighborhood|neighbourhood|community|area|families)\b/, message: 'Describes the people who live nearby rather than the property.', suggestion: MSG.raceTip },
  { id: 'st-safe-area', category: 'steering_language', severity: 'warn', re: /\b(safe|safest|crime free|low crime)\s+(neighborhood|neighbourhood|area|community|part\s+of\s+town|street)\b/, message: 'Safety claims about a neighborhood can work as steering.', suggestion: 'Name specific features instead, such as controlled access or on-site staff.' },
];

export function normalizeForLint(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[-\u2010\u2011\u2012\u2013\u2014_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function lintAdCopy(fields: Array<{ field: string; text: string }>): FairHousingReport {
  const findings: FairHousingFinding[] = [];
  for (const { field, text } of fields) {
    const normalized = normalizeForLint(text);
    for (const rule of RULES) {
      const m = rule.re.exec(normalized);
      if (m) {
        findings.push({
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          field,
          text,
          match: m[0],
          message: rule.message,
          suggestion: rule.suggestion,
        });
      }
    }
  }
  const status = findings.some((f) => f.severity === 'block') ? 'block' : findings.length > 0 ? 'warn' : 'clean';
  return { status, findings, disclaimer: FAIR_HOUSING_DISCLAIMER };
}

export function lintAd(headlines: string[], descriptions: string[]): FairHousingReport {
  return lintAdCopy([
    ...headlines.map((text, i) => ({ field: `Headline ${i + 1}`, text })),
    ...descriptions.map((text, i) => ({ field: `Description ${i + 1}`, text })),
  ]);
}

/**
 * Terms that relate to a protected characteristic or a lawful source of income.
 * Excluding them with negative keywords can keep members of a protected group
 * from seeing housing ads, so the tool never adds them. A person can still
 * make that call outside the tool.
 */
const PROTECTED_TERMS: Array<{ category: Category; terms: string[] }> = [
  { category: 'disability', terms: ['accessible', 'accessibility', 'wheelchair', 'ada', 'handicap', 'handicapped', 'disabled', 'disability', 'disabilities', 'service animal', 'service animals', 'service dog', 'assistance animal', 'assistance animals', 'emotional support', 'esa'] },
  { category: 'familial_status', terms: ['family', 'families', 'kid', 'kids', 'child', 'children', 'baby', 'babies', 'infant', 'infants', 'toddler', 'toddlers', 'pregnant'] },
  { category: 'source_of_income', terms: ['section 8', 'section8', 'voucher', 'vouchers', 'hcv', 'housing choice', 'housing assistance', 'subsidized', 'income restricted', 'income based', 'low income'] },
  { category: 'religion', terms: ['church', 'christian', 'catholic', 'jewish', 'kosher', 'muslim', 'mosque', 'synagogue', 'temple', 'halal', 'hindu', 'buddhist', 'sikh', 'mormon'] },
  { category: 'race_color_national_origin', terms: ['black', 'african american', 'asian', 'hispanic', 'latino', 'latina', 'latinx', 'spanish', 'espanol', 'español', 'bilingual', 'chinese', 'korean', 'vietnamese', 'somali', 'hmong', 'arabic', 'immigrant', 'immigrants', 'refugee', 'refugees', 'international students'] },
  { category: 'sex', terms: ['women', 'woman', 'men', 'female', 'male', 'lgbt', 'lgbtq', 'gay', 'lesbian', 'transgender', 'queer'] },
  { category: 'age', terms: ['senior', 'seniors', 'elderly', 'retiree', 'retirees', 'retirement', '55+', '55 and older', '62+'] },
  { category: 'military_status', terms: ['veteran', 'veterans', 'military'] },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PROTECTED_MATCHERS = PROTECTED_TERMS.flatMap(({ category, terms }) =>
  terms.map((term) => ({
    category,
    term,
    re: new RegExp(`(?<![a-z0-9])${escapeRe(normalizeForLint(term)).replace(/ /g, '\\s+')}(?![a-z0-9])`),
  })),
);

export function protectedTermIn(keyword: string): { term: string; category: string } | undefined {
  const normalized = normalizeForLint(keyword);
  for (const m of PROTECTED_MATCHERS) {
    if (m.re.test(normalized)) return { term: m.term, category: m.category };
  }
  return undefined;
}

export function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    familial_status: 'familial status',
    disability: 'disability',
    race_color_national_origin: 'race, color or national origin',
    religion: 'religion',
    sex: 'sex',
    source_of_income: 'source of income',
    age: 'age',
    steering_language: 'steering language',
    military_status: 'military status',
  };
  return labels[category] ?? category;
}
