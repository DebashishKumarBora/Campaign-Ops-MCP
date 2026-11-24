import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintAdCopy, protectedTermIn } from '../src/governance/fairHousing.js';

const lint = (text: string) => lintAdCopy([{ field: 'Headline 1', text }]);

test('blocks phrases that state a preference or limitation', () => {
  const cases = [
    'Quiet adults-only community',
    'No children please',
    'Kids are not allowed in the pool',
    'Perfect for couples',
    'Ideal for singles',
    'No Section 8',
    'Vouchers not accepted',
    'English speakers only',
    'Must speak English',
    'Christian community',
    'No wheelchairs',
    'Able-bodied tenants preferred',
    'Must be able to climb stairs',
    'Female only',
    'No service animals',
    'White neighborhood',
    'Child-free building',
    'Maximum of 1 child',
    'Adult community near downtown',
  ];
  for (const text of cases) {
    const report = lint(text);
    assert.equal(report.status, 'block', `expected block for "${text}", got ${report.status}`);
  }
});

test('warns on coded or age-signaling language', () => {
  const cases = ['Ideal for young professionals', 'Exclusive community', 'Safe neighborhood', 'Great for empty nesters', 'Perfect for students', 'Mature residents'];
  for (const text of cases) {
    const report = lint(text);
    assert.equal(report.status, 'warn', `expected warn for "${text}", got ${report.status}`);
  }
});

test('does not flag ordinary property descriptions', () => {
  const cases = [
    'Spacious family room',
    'Master bedroom with walk-in closet',
    'Walk to the bus stop',
    'Wheelchair ramp at the entrance',
    'Non-smoking building',
    "Kids' play area and dog park",
    "Near St. Mark's Church",
    'Two bedroom homes',
    'Pet friendly living',
    'Resort-style pool and rooftop lounge',
    'No pets over 50 lbs',
    'Book a tour today',
    'Amenities include a gym',
  ];
  for (const text of cases) {
    const report = lint(text);
    assert.equal(report.status, 'clean', `expected clean for "${text}", got ${report.status}: ${report.findings.map((f) => f.ruleId).join(',')}`);
  }
});

test('reports the field and matched phrase for each finding', () => {
  const report = lintAdCopy([
    { field: 'Headline 2', text: 'Ideal for Young Professionals' },
    { field: 'Description 1', text: 'Quiet adults-only community near downtown.' },
  ]);
  assert.equal(report.status, 'block');
  assert.deepEqual(
    report.findings.map((f) => [f.field, f.match, f.severity]),
    [
      ['Headline 2', 'young professionals', 'warn'],
      ['Description 1', 'adults only', 'block'],
    ],
  );
  assert.match(report.disclaimer, /not legal advice/);
});

test('detects protected terms in negative keywords with whole-word matching', () => {
  assert.equal(protectedTermIn('section 8 apartments')?.category, 'source_of_income');
  assert.equal(protectedTermIn('wheelchair accessible apartments')?.category, 'disability');
  assert.equal(protectedTermIn('family friendly apartments')?.category, 'familial_status');
  assert.equal(protectedTermIn('55+ community')?.category, 'age');
  assert.equal(protectedTermIn('apartments near mosque')?.category, 'religion');
  assert.equal(protectedTermIn('apartment jobs'), undefined);
  assert.equal(protectedTermIn('amenities'), undefined, '"men" inside "amenities" is not a match');
  assert.equal(protectedTermIn('adams street lofts'), undefined, '"ada" inside "adams" is not a match');
  assert.equal(protectedTermIn('female roommate')?.term, 'female');
});
