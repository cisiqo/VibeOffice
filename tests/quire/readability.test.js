// Quire's syllable counter (readability statistics) and ordinal suffixes, written for todos/CLEAN_APACHE2.0.md:
//   node --test tests/quire/readability.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.window = globalThis;
require('../../public/common/core.js');
require('../../public/common/spell.js');
require('../../public/quire/js/dmodel.js');
require('../../public/quire/js/spell.js');
const { D, spell: SP } = L;

test('syllables: vowel groups, vowels said apart, silent endings (as the CMU Pronouncing Dictionary has them)', () => {
  const words = { the: 1, a: 1, yes: 1, make: 1, table: 2, wanted: 2, jumped: 1, boxes: 2, changes: 2, makes: 1, files: 1, tables: 2,
    media: 3, piano: 3, geometry: 4, actual: 3, layout: 2, beautiful: 3, nation: 2, special: 2, region: 2, behavior: 3,
    document: 3, spreadsheet: 2, presentation: 4, readability: 5, everyone: 3, statistics: 3, simple: 2, people: 2 };
  for (const [w, n] of Object.entries(words)) assert.equal(SP.syllables(w), n, w);
  assert.equal(SP.syllables("Don't"), 1, 'letters only');
  assert.equal(SP.syllables('42'), 1, 'at least one');
});

test('ordinal numbers: 1st 2nd 3rd 4th, 11th 12th 13th, 21st 111th 112th 1001st', () => {
  const got = [1, 2, 3, 4, 10, 11, 12, 13, 14, 21, 22, 23, 101, 111, 112, 113, 1001, 0, -1].map((n) => D.fmtNum(n, 'ordinal'));
  assert.deepEqual(got, ['1st', '2nd', '3rd', '4th', '10th', '11th', '12th', '13th', '14th', '21st', '22nd', '23rd', '101st', '111th', '112th', '113th', '1001st', '0th', '-1th']);
});
