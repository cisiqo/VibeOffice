// The 17 SpreadsheetML cell-fill patterns (ECMA-376 ST_PatternType, without none and solid), black on white, each in a
// wide cell of its own row beside its name, saved as tmp/patterns/cellpatterns.xlsx. Open it in Excel, save it as PDF,
// and read the tiles with read-pdf.py --cells (Ledger's js/render.js; tests/patterns.test.mjs):
//   node tools/patterns/sheet.mjs
import fs from 'node:fs';
import { ensureServer, openPage } from '../ooxml/cdp.mjs';
const NAMES = ['darkGray', 'mediumGray', 'lightGray', 'gray125', 'gray0625', 'darkHorizontal', 'darkVertical', 'darkDown', 'darkUp', 'darkGrid',
  'darkTrellis', 'lightHorizontal', 'lightVertical', 'lightDown', 'lightUp', 'lightGrid', 'lightTrellis'];
const stop = await ensureServer();
const page = await openPage('ledger', { automated: true });
try {
  const b64 = await page.evaluate(`(async () => {
    const M = L.model, names = ${JSON.stringify(NAMES)};
    const wb = new M.Workbook(), sh = wb.addSheet('Patterns');
    sh.colObj(0).w = 16; sh.colObj(0).custom = true;
    sh.colObj(1).w = 40; sh.colObj(1).custom = true;
    names.forEach((name, i) => {
      const r = i * 2;
      sh.cell(r, 0).v = name;
      sh.cell(r, 1).s = wb.styles.add(M.mergeStyle(M.defaultStyle(), { fill: { pattern: name, fg: { rgb: 'FF000000' }, bg: { rgb: 'FFFFFFFF' } } }));
      const row = sh.rowObj(r); row.ht = 60; row.customHeight = true;
    });
    const bytes = await L.xlsxWrite.bytes(wb, { type: 'xlsx' });
    let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(s);
  })()`);
  fs.mkdirSync('tmp/patterns', { recursive: true });
  fs.writeFileSync('tmp/patterns/cellpatterns.xlsx', Buffer.from(b64, 'base64'));
  console.log('saved tmp/patterns/cellpatterns.xlsx', fs.statSync('tmp/patterns/cellpatterns.xlsx').size, 'bytes');
  if (page.errors.length) console.log('errors', page.errors);
} finally { await page.close(); stop(); }
