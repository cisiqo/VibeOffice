// Issue #11, as Quire draws it: linegrid.docx (tools/linegrid.py) against Word's PDF of it (word.json). The lines of
// each of the 90 cases are as far apart as Word puts them (runs that fit keep their own line height and don't stretch
// the grid line), and pages break where Word's do: on a grid, Word centres the text in its line, and only the space
// below the text may run into the bottom margin (public/quire/js/layout.js). Pages 1 to 5 and the 18pt grid's; the
// Chinese pages wrap differently (fonts) and page 5 ends in a tie decided by Word's 1/300-inch raster.
//   node --test tests/from-issues/11/render.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ensureServer, openPage } from '../../../tools/ooxml/cdp.mjs';

const word = JSON.parse(fs.readFileSync(new URL('word.json', import.meta.url), 'utf8'));
const docx = fs.readFileSync(new URL('linegrid.docx', import.meta.url)).toString('base64');

test('Issue 11: linegrid.docx spaced and paginated as Word does', async () => {
  const stop = await ensureServer();
  const page = await openPage('quire', { persistence: false, automated: true });
  try {
    const got = await page.evaluate(`(async () => {
      VO.opened = () => {}; L.layout.view = 'print'; L.layout.setZoom(1);
      const bytes = Uint8Array.from(atob(${JSON.stringify(docx)}), (c) => c.charCodeAt(0));
      const { doc } = await L.docx.read(bytes.buffer);
      L.app.loadDoc(doc, 'linegrid', { saved: true });
      await document.fonts.ready; L.layout.render(); await new Promise((r) => setTimeout(r, 300));
      const LY = L.layout, ids = {}, seen = {}, gaps = {}, pages = [];
      for (const pg of LY.pages) {
        const top = pg.body.getBoundingClientRect().top;
        let first = null;
        for (const f of pg.body.querySelectorAll('.p')) {
          const key = (f.textContent.match(/^\\[[0-9.]+\\/[0-9.]+\\/[0-9.]+(\\/zh)?\\]/) || [])[0] || ids[f.dataset.pid];
          const tops = LY.lines(f, top, 1).map((l) => l.top);
          if (!key || !tops.length) continue;
          ids[f.dataset.pid] = key;
          if (!first) first = key + ' line ' + ((seen[key] || 0) + 1);
          seen[key] = (seen[key] || 0) + tops.length;
          (gaps[key] = gaps[key] || []).push(...tops.slice(1).map((t, i) => (t - tops[i]) * 72 / 96));
        }
        pages.push(first);
      }
      return { gaps, pages };
    })()`);
    for (const [key, pt] of Object.entries(word.lines)) {
      assert.ok(got.gaps[key] && got.gaps[key].length, `${key}: no lines measured`);
      for (const g of got.gaps[key]) assert.ok(Math.abs(g - pt) < 0.15, `${key}: lines ${g.toFixed(2)}pt apart, Word ${pt}pt`);
    }
    assert.deepEqual(got.pages.slice(0, 5), word.pages.slice(0, 5), 'pages 1 to 5 start where Word\'s do');
    const at = (pages) => pages.indexOf('[18/10.5/1] line 1');
    assert.deepEqual(got.pages.slice(at(got.pages)), word.pages.slice(at(word.pages)), 'the 18pt grid\'s pages start where Word\'s do');
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); stop(); }
});
