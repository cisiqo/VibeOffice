// Preset pattern fills (public/common/geometry.js, PATTERNS), one table for Lectern and Quire, as PowerPoint draws them:
// tests/patterns.powerpoint.json was read from PowerPoint's PDF of the deck tools/patterns/deck.mjs makes
// (tools/patterns/read-pdf.py). Ledger's cell patterns (js/render.js, CELL_PATTERNS) are learned from Excel for Mac's PDF
// of tools/patterns/sheet.mjs's workbook (tests/patterns.excel-mac.json, read-pdf.py --cells) and brought to single
// pixels by the rule its comment gives:  node --test tests/patterns.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
globalThis.window = globalThis;
require('../public/common/core.js');
require('../public/common/geometry.js');
require('../public/ledger/js/model.js');
require('../public/ledger/js/render.js');
const G = globalThis.L.geom, RD = globalThis.L.render;
const powerpoint = JSON.parse(fs.readFileSync(path.join(root, 'tests/patterns.powerpoint.json'), 'utf8'));
const excelMac = JSON.parse(fs.readFileSync(path.join(root, 'tests/patterns.excel-mac.json'), 'utf8'));

test('the 54 presets, each the tile PowerPoint draws', () => {
  assert.equal(Object.keys(powerpoint).length, 54);
  assert.deepEqual(G.PATTERNS, powerpoint);
});

test('light lines are closer together than the plain ones, as in PowerPoint', () => {
  const lines = (rows) => rows.filter((r) => r === 0xFF).length;
  assert.equal(lines(G.PATTERNS.horz), 1);
  assert.equal(lines(G.PATTERNS.ltHorz), 2);
  assert.deepEqual(G.PATTERNS.cross, G.PATTERNS.lgGrid);
});

test('Lectern and Quire keep no table of their own', () => {
  for (const f of ['public/lectern/js/render.js', 'public/quire/js/drawing.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /L\.geom\.PATTERNS/, f);
    assert.doesNotMatch(src, /pct50:\s*\[/, f);
  }
});

test('patternPath: one unit square per set bit', () => {
  assert.equal(G.patternPath([0x80, 0, 0, 0, 0, 0, 0, 0x01]), 'M0,0h1v1h-1zM7,7h1v1h-1z');
});

test('Ledger: the 17 cell patterns from Excel for Mac, at single pixels', () => {
  const GREYS = ['darkGray', 'mediumGray', 'lightGray', 'gray125', 'gray0625'];
  const bit = (t, x, y) => (t[y] >> (7 - x)) & 1;
  const everyOther = (t) => Array.from({ length: 8 }, (_, y) => { let v = 0; for (let x = 0; x < 8; x++) v = v << 1 | bit(t, (x % 4) * 2, (y % 4) * 2); return v; });
  const want = {};
  for (const [n, t] of Object.entries(excelMac)) {
    const g = GREYS.indexOf(n);
    want[n] = g < 0 ? everyOther(t) : g === 0 ? excelMac.mediumGray.map((r) => r ^ 0xFF) : excelMac[GREYS[g - 1]];
  }
  assert.equal(Object.keys(excelMac).length, 17);
  assert.deepEqual(RD.CELL_PATTERNS, want);
});

test('Ledger: each grey covers what its name says', () => {
  const cover = (t) => t.reduce((n, r) => n + r.toString(2).split('1').length - 1, 0) / 64;
  for (const [n, c] of [['darkGray', 0.75], ['mediumGray', 0.5], ['lightGray', 0.25], ['gray125', 0.125], ['gray0625', 0.0625]]) assert.equal(cover(RD.CELL_PATTERNS[n]), c, n);
});

test('Ledger: the Format Cells swatches use the same table', () => {
  const src = fs.readFileSync(path.join(root, 'public/ledger/js/dialogs.js'), 'utf8');
  assert.match(src, /L\.render\.patternURL/);
  assert.doesNotMatch(src, /darkGray:\s*\[/);
});
