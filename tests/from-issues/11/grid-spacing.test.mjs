// Issue #11: a document with a line grid (15.6pt) and 14pt text at 1.7-line spacing had lines 53.04pt apart in Quire;
// Word draws them 31.2pt apart. A line on the grid is the pitch times the spacing multiple, and at least the whole
// pitches its text needs (public/quire/js/render.js, R.gridLine), as Word draws the 90 cases of linegrid.docx
// (tools/linegrid.py; word.json, read from Word for Mac's PDF, where lines sit on a 1/300-inch raster):
//   node --test tests/from-issues/11/grid-spacing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.window = globalThis;
require('../../../public/common/core.js');
require('../../../public/quire/js/dmodel.js');
require('../../../public/quire/js/render.js');
const R = globalThis.L.R;
const word = JSON.parse(fs.readFileSync(new URL('word.json', import.meta.url), 'utf8'));
/** line height in points for text of sz points in font, at mult lines, on a grid of pitch points */
const line = (sz, font, mult, pitch = 15.6) => Math.round(R.gridLine(R.px(pitch), mult, sz, font) * 72 / 96 * 100) / 100;

test('Issue 11: 14pt text at 1.7 lines takes two pitches of a 15.6pt grid; 1.5 lines of smaller text, 23.4pt', () => {
  assert.equal(line(14, 'Times New Roman', 1.7), 31.2);
  assert.equal(line(10.5, 'SimSun', 1.5), 23.4);
});

test('the line height of each of the 90 cases as Word draws it', () => {
  assert.equal(Object.keys(word.lines).length, 90);
  for (const [key, pt] of Object.entries(word.lines)) {
    const [pitch, sz, mult] = key.slice(1, -1).split('/').map(Number);
    const got = line(sz, 'Times New Roman', mult, pitch);
    assert.ok(Math.abs(got - pt) < 0.15, `${key}: ${got}pt, Word ${pt}pt`);
  }
});
