// The 54 preset patterns (ECMA-376 ST_PresetPatternVal), black on white, each in a large labelled rectangle, saved as
// tmp/patterns/patterns.pptx. Open it in PowerPoint, save it as PDF, and read the tiles with read-pdf.py (common/geometry.js,
// PATTERNS; tests/patterns.test.mjs):  node tools/patterns/deck.mjs
import fs from 'node:fs';
import { ensureServer, openPage } from '../ooxml/cdp.mjs';
const NAMES = ['pct5', 'pct10', 'pct20', 'pct25', 'pct30', 'pct40', 'pct50', 'pct60', 'pct70', 'pct75', 'pct80', 'pct90', 'horz', 'vert', 'ltHorz', 'ltVert',
  'dkHorz', 'dkVert', 'narHorz', 'narVert', 'dashHorz', 'dashVert', 'cross', 'dnDiag', 'upDiag', 'ltDnDiag', 'ltUpDiag', 'dkDnDiag', 'dkUpDiag', 'wdDnDiag',
  'wdUpDiag', 'dashDnDiag', 'dashUpDiag', 'diagCross', 'smCheck', 'lgCheck', 'smGrid', 'lgGrid', 'dotGrid', 'smConfetti', 'lgConfetti', 'horzBrick',
  'diagBrick', 'solidDmnd', 'openDmnd', 'dotDmnd', 'plaid', 'sphere', 'weave', 'divot', 'shingle', 'wave', 'trellis', 'zigZag'];
const stop = await ensureServer();
const page = await openPage('lectern', { automated: true });
try {
  const b64 = await page.evaluate(`(async () => {
    const M = L.model, names = ${JSON.stringify(NAMES)};
    const pres = M.newPresentation({ empty: true, w: 960, h: 540 });
    const per = 18, cols = 6, w = 130, h = 84, gx = 20, gy = 40;
    for (let s = 0; s * per < names.length; s++) {
      const slide = M.newSlide(pres, 'blank'); pres.slides.push(slide);
      names.slice(s * per, s * per + per).forEach((name, i) => {
        const x = 30 + (i % cols) * (w + gx), y = 40 + Math.floor(i / cols) * (h + gy + 20);
        const sh = M.newShape(pres, slide, 'rect', x, y, w, h);
        sh.fill = { t: 'patt', prst: name, fg: '#000000', bg: '#FFFFFF' }; sh.line = { c: '#FF0000', w: 1, dash: 'solid' }; sh.name = name;
        slide.shapes.push(sh);
        const tb = M.newTextBox(pres, slide, x, y + h + 2, w, 22);
        tb.tx.ps = [L.txt.para(name, { algn: 'ctr' })];
        tb.name = 'label ' + name; slide.shapes.push(tb);
      });
    }
    const blob = await L.pptx.write(pres);
    const a = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode(...a.subarray(i, i + 32768)); return btoa(s);
  })()`);
  fs.mkdirSync('tmp/patterns', { recursive: true });
  fs.writeFileSync('tmp/patterns/patterns.pptx', Buffer.from(b64, 'base64'));
  console.log('saved tmp/patterns/patterns.pptx', fs.statSync('tmp/patterns/patterns.pptx').size, 'bytes');
  if (page.errors.length) console.log('errors', page.errors);
} finally { await page.close(); stop(); }
