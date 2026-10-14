// Theme-colour tints (M.applyTint) use the suite's HSL conversions in common/core.js (L.color), with no copy of
// their own in Ledger, and keep their results:  node --test tests/ledger/tint.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../public/common/core.js');
require('../../public/ledger/js/model.js');
const { model: M, color: C } = globalThis.L;

test('tints go through L.color', () => {
  const calls = [];
  const [toHsl, toRgb] = [C.rgbToHsl, C.hslToRgb];
  C.rgbToHsl = (...a) => (calls.push('rgbToHsl'), toHsl(...a));
  C.hslToRgb = (...a) => (calls.push('hslToRgb'), toRgb(...a));
  try { M.applyTint('#4F81BD', 0.4); } finally { [C.rgbToHsl, C.hslToRgb] = [toHsl, toRgb]; }
  assert.deepEqual(calls, ['rgbToHsl', 'hslToRgb']);
});

test('lighter and darker shades of the theme colours', () => {
  assert.equal(M.applyTint('#4F81BD', 0.4), '#95B3D7');
  assert.equal(M.applyTint('#4F81BD', -0.25), '#376092');
  assert.equal(M.applyTint('#4F81BD', 0), '#4F81BD');
  assert.equal(M.applyTint('#000000', 0.5), '#808080');
  assert.equal(M.applyTint('#FFFFFF', -0.5), '#808080');
  assert.equal(M.colorHex(null, { theme: 4, tint: 0.399975585192419 }), M.applyTint(M.DEFAULT_THEME.colors[4], 0.399975585192419));
});
