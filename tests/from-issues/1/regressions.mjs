// Browser regressions for issue #1. Own tabs only; no Recent Files or drafts.
// node tests/from-issues/1/regressions.mjs OUTPUT [fill|fields|marks|breaks]
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer, openPage } from '../../../tools/ooxml/cdp.mjs';
const [output, filter] = process.argv.slice(2);
if (!output) throw new Error('Usage: node tests/from-issues/1/regressions.mjs OUTPUT [fill|fields|marks|breaks]');
fs.mkdirSync(output, { recursive: true });
const stop = await ensureServer(), results = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 150));
try {
  for (const [name, app, fn] of [['fill', 'ledger', fill], ['fields', 'quire', fields], ['marks', 'quire', marks], ['breaks', 'quire', breaks]]) {
    if (filter && filter !== name) continue;
    const page = await openPage(app, { persistence: false });
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('VO.opened = () => {}; document.fonts.ready');
      if (app === 'quire') await page.evaluate('L.layout.view = "print"; L.layout.setZoom(1)');
      await pause();
      if (name === 'fill') {
        for (const direction of ['down', 'right']) {
          await page.evaluate(`(${fn.toString()})(${JSON.stringify(direction)}, 'setup')`);
          await pause();
          const key = direction === 'down' ? 'D' : 'R';
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: key.toLowerCase(), code: 'Key' + key, modifiers: 2, windowsVirtualKeyCode: key.charCodeAt(0) });
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.toLowerCase(), modifiers: 2 });
          await pause();
          await page.evaluate(`(${fn.toString()})(${JSON.stringify(direction)}, 'check')`);
        }
      } else {
        const value = await page.evaluate(`(${fn.toString()})()`);
        for (const [file, data] of Object.entries(value?.artifacts || {})) fs.writeFileSync(path.join(output, file), Buffer.from(data, 'base64'));
      }
      if (page.errors.length || page.requests.length) throw new Error(JSON.stringify({ errors: page.errors, requests: page.requests }));
      results.push({ name, status: 'ok' });
    } catch (error) {
      results.push({ name, status: 'failed', error: error.message }); process.exitCode = 1;
    } finally {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
      await page.close();
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally { stop(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); }

function fill(direction, phase) {
  const { app: A, grid: G, ops: O } = L;
  const vertical = direction === 'down';
  if (phase === 'setup') {
    A.addBook(A.blankWorkbook(), 'Fill regression', { untitled: true });
    const sh = G.sheet(), style = G.wb.styles.add({ font: { b: true } });
    O.enter(sh, 0, 0, '7');
    O.enter(sh, vertical ? 0 : 1, vertical ? 1 : 0, '=A1+$A$1');
    const source = sh.get(vertical ? 0 : 1, vertical ? 1 : 0); source.s = style;
    G.select(0, 0); G.extendTo(vertical ? 3 : 1, vertical ? 1 : 3); G.focus();
    return;
  }
  const sh = G.sheet(), check = (ok, message) => { if (!ok) throw new Error(direction + ': ' + message); };
  const assertFilled = () => {
    for (let i = 1; i <= 3; i++) {
      check(sh.val(vertical ? i : 0, vertical ? 0 : i) === 7, 'blank destination was not filled');
      const cell = sh.get(vertical ? i : 1, vertical ? 1 : i);
      check(cell?.f === (vertical ? `A${i + 1}` : String.fromCharCode(65 + i) + '1') + '+$A$1', 'relative formula was not translated');
      check(G.wb.styles.get(cell.s).font.b, 'formatting was not copied');
    }
  };
  assertFilled(); A.undo(); check(!sh.get(vertical ? 3 : 0, vertical ? 0 : 3), 'undo left filled cells'); A.redo(); assertFilled();
  G.select(vertical ? 4 : 0, vertical ? 0 : 4); A.fillDir(direction);
  check(sh.val(vertical ? 4 : 0, vertical ? 0 : 4) === 7, 'single-cell fill failed');
  // Bound the whole dimension without cutting off explicit blank destinations.
  G.selectRange({ r1: 0, c1: 0, r2: vertical ? 6 : L.model.MAXR - 1, c2: vertical ? L.model.MAXC - 1 : 6 });
  A.fillDir(direction);
  check(sh.val(vertical ? 6 : 0, vertical ? 0 : 6) === 7, 'whole row/column fill clipped the explicit destination');
  G.select(0, 0); A.fillDir(direction); check(sh.val(0, 0) === 7, 'sheet-edge fill changed its source');
}

async function fields() {
  const { D, layout: LY } = L;
  LY.opts.showMarks = false; LY.root.classList.remove('marks');
  const d = D.newDoc();
  const field = (id, type) => [D.item('fb', { fid: id, instr: ' ' + type + ' ' }), D.item('fs', { fid: id }), D.text('1'), D.item('fe', { fid: id })];
  const footer = D.para([D.text('Left'), D.item('tab'), D.text('Page '), ...field('page', 'PAGE'), D.text(' of '), ...field('total', 'NUMPAGES')], { tabs: [{ pos: 432, al: 'right' }] });
  const header = D.para([D.item('tab'), ...field('section', 'SECTIONPAGES')], { tabs: [{ pos: 216, al: 'center' }] });
  d.hf.f1 = { kind: 'ftr', id: 'f1', blocks: [footer] }; d.hf.h1 = { kind: 'hdr', id: 'h1', blocks: [header] };
  d.sect.refs = { ftr: { default: 'f1' }, hdr: { default: 'h1' } };
  L.app.loadDoc(d, 'Page fields', { saved: true });
  for (const count of [9, 10, 9, 99, 100, 99]) {
    d.main.blocks = Array.from({ length: count }, (_, i) => D.para([D.text('Page ' + (i + 1))], { pageBreakBefore: i > 0 }));
    LY.render();
    if (LY.pages.length !== count) throw new Error('Unexpected page count: ' + LY.pages.length);
    for (const pg of LY.pages) {
      const nodes = pg.ftr.querySelectorAll('.fdyn'), a = nodes[0].getBoundingClientRect(), b = nodes[1].getBoundingClientRect();
      if (nodes[1].textContent !== String(count) || Math.abs(a.top - b.top) > 1) throw new Error(count + ' pages: footer fields wrap');
      const edge = pg.ftr.getBoundingClientRect().right;
      if (Math.abs(b.right - edge) > 1) throw new Error(count + ' pages: footer right tab is misaligned');
      const h = pg.hdr.querySelector('.fdyn'), r = h.getBoundingClientRect(), hr = pg.hdr.getBoundingClientRect();
      if (h.textContent !== String(count) || Math.abs((r.left + r.right) / 2 - (hr.left + hr.right) / 2) > 1) throw new Error('Header section count is not centered');
    }
  }
  // Totals in body paragraphs must be measured before pagination as well.
  d.main.blocks = Array.from({ length: 10 }, (_, i) => D.para([D.item('tab'), ...field('body' + i, 'NUMPAGES')], { pageBreakBefore: i > 0, tabs: [{ pos: 432, al: 'right' }] }));
  d.main.blocks[3].sect = L.clone(d.sect); LY.render();
  const counts = LY.pages.map(pg => LY.pages.filter(p => p.si === pg.si).length);
  for (const pg of LY.pages) {
    const f = pg.body.querySelector('.fdyn'), rect = f.getBoundingClientRect(), pc = f.closest('.pc').getBoundingClientRect();
    if (f.textContent !== '10' || Math.abs(rect.right - pc.right) > 1) throw new Error('Body total is not measured at the right tab');
    if (pg.hdr.querySelector('.fdyn').textContent !== String(counts[pg.idx])) throw new Error('Section total counted another section');
  }
  const bytes = new Uint8Array(await (await L.docx.write(d)).arrayBuffer());
  // Totals that change no line's height cost no second layout; one that wraps a line lays pages
  // out again from its page on, the same as a fresh layout.
  const passes = [], paginate = LY.paginate;
  LY.paginate = function (from, pass) { passes.push(from || 0); return paginate.apply(this, arguments); };
  try {
    const lorem = 'The quick brown fox jumps over the lazy dog while the committee reviews the figures. ';
    const words = (body) => { const d2 = D.newDoc(); d2.hf.f1 = { kind: 'ftr', id: 'f1', blocks: [L.clone(footer)] }; d2.sect.refs = { ftr: { default: 'f1' } }; d2.main.blocks = body; return d2; };
    const filler = Array.from({ length: 700 }, (_, i) => D.para([D.text(lorem.repeat(3 + i % 4))]));
    passes.length = 0; L.app.loadDoc(words(filler), 'Page fields', { saved: true });
    if (LY.pages.length < 40 || passes.length !== 1) throw new Error(LY.pages.length + " pages, laid out " + passes.length + " times on open");
    const total = (text) => D.para([D.text(text + ' of '), D.item('fb', { fid: 'w', instr: ' NUMPAGES \\* CardText ' }), D.item('fs', { fid: 'w' }), D.text('one'), D.item('fe', { fid: 'w' })]);
    const height = (t) => { L.app.loadDoc(words([total(t)]), 'probe', { saved: true }); return LY.pages[0].body.querySelector('.p').offsetHeight; };
    let text = 'Total';
    for (let n = 0, one = height(text); n < 60 && height(text + ' word') === one; n++) text += ' word';
    const body = filler.slice(); body.splice(500, 0, total(text));
    passes.length = 0; L.app.loadDoc(words(body), 'Page fields', { saved: true });
    const starts = () => LY.pages.map((p) => body.indexOf(p.start.block) + ':' + JSON.stringify(p.start.sub)).join('|');
    const inWords = LY.pages.map((p) => p.body.querySelector('.fdyn')).find(Boolean);
    if (!inWords || !/ty|hundred/.test(inWords.textContent)) throw new Error('Total in words not filled in: ' + (inWords && inWords.textContent));
    if (passes.length !== 2 || !(passes[1] > 0)) throw new Error('A wrapping total re-laid pages ' + JSON.stringify(passes));
    const after = starts(); LY.paginate(0);
    if (starts() !== after) throw new Error('Partial layout after a wrapping total differs from a full layout');
  } finally { LY.paginate = paginate; }
  return { artifacts: { 'page-fields.docx': btoa(Array.from(bytes, c => String.fromCharCode(c)).join('')) } };
}

async function marks() {
  const { D, layout: LY } = L;
  const d = L.app.buildSample();
  d.main.blocks.push(D.para([D.text('Line one'), D.item('br', { type: 'line' }), D.text('Line two')]));
  d.main.blocks.push(D.para([D.text('Page end'), D.item('br', { type: 'page' }), D.text('Next page')]));
  L.app.loadDoc(d, 'Formatting marks', { saved: true });
  const measure = () => {
    const out = [];
    for (const p of LY.root.querySelectorAll('.p')) {
      const r = p.getBoundingClientRect(); out.push([p.dataset.pid, r.x, r.y, r.height]);
      for (const sp of p.querySelectorAll(':scope > .pc > [data-o]')) {
        const node = sp.firstChild;
        if (node?.nodeType !== 3) continue;
        for (let i = 0; i < node.length; i++) {
          const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect(); out.push([+sp.dataset.o + i, r.x, r.y, r.width]);
        }
      }
    }
    return out;
  };
  for (const view of ['print', 'web']) {
    LY.view = view;
    LY.opts.showMarks = false; LY.root.classList.remove('marks'); LY.render(); const before = measure(), pages = LY.pages.length;
    L.ui.exec('showMarks'); const after = measure();
    if (pages !== LY.pages.length || before.length !== after.length) throw new Error('Show/Hide changed pages or text structure');
    for (let i = 0; i < before.length; i++) for (let j = 0; j < 4; j++) if (typeof before[i][j] === 'number' ? Math.abs(before[i][j] - after[i][j]) > 0.1 : before[i][j] !== after[i][j]) throw new Error('Show/Hide moved text: ' + JSON.stringify({ before: before[i], after: after[i] }));
    if (!LY.root.querySelector('.format-marks i') || !LY.root.querySelector('.mark-p') || !LY.root.querySelector('.mark-br')) throw new Error('Formatting symbols are missing');
  }
  LY.view = 'print'; LY.render();
}

async function breaks() {
  const { D, O, layout: LY } = L, artifacts = {};
  const save = async (name, blob) => { const a = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode(...a.subarray(i, i + 32768)); artifacts[name] = btoa(s); };
  const base = await L.docx.write(D.newDoc()), zip = await L.zip.read(new Uint8Array(await base.arrayBuffer()));
  const files = await Promise.all(Array.from(zip, async ([name, entry]) => ({ name, data: await entry.bytes() })));
  const main = files.find(f => f.name === 'word/document.xml');
  main.data = L.zip.decode(main.data).replace(/<w:body>[\s\S]*?<w:sectPr/, '<w:body><w:p><w:r><w:t xml:space="preserve">First&#13;Second&#13;Third</w:t></w:r></w:p><w:p><w:r><w:t>First&#13;Second&#13;Third</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">First&#13;&#10;Second&#13;&#10;Third</w:t></w:r></w:p><w:sectPr');
  const original = await L.zip.write(files); await save('carriage-return-original.docx', original);
  const d = (await L.docx.read(new Uint8Array(await original.arrayBuffer()))).doc;
  L.app.loadDoc(d, 'Carriage returns', { saved: true });
  const p = d.main.blocks[0];
  const check = () => {
    LY.render();
    for (const p of d.main.blocks) {
      const tops = [];
      for (const text of ['First', 'Second', 'Third']) {
        const o = D.ptext(p).indexOf(text), dom = LY.posToDom(D.pos(p, o));
        const r = document.createRange(); r.setStart(dom.node, dom.offset); r.setEnd(dom.node, dom.offset + 1); tops.push(r.getBoundingClientRect().top);
      }
      if (!(tops[0] < tops[1] && tops[1] < tops[2])) throw new Error('Carriage returns did not break lines: ' + tops);
      const height = LY.fragFor(p, 0).getBoundingClientRect().height;
      if (height > 3.1 * (tops[1] - tops[0]) || tops[1] - tops[0] > 20) throw new Error('CRLF inserted an extra blank line');
    }
  };
  check(); await save('carriage-return-saved.docx', await L.docx.write(d));
  D.tx('Edit after a carriage return', () => O.insertText(D.pos(p, 6), 'edited ')); check();
  await save('carriage-return-edited.docx', await L.docx.write(d));
  D.undo(); check(); D.redo(); check();
  const copy = (await L.docx.read(new Uint8Array(await (await L.docx.write(d)).arrayBuffer()))).doc;
  if (JSON.stringify(copy.main.blocks.map(p => D.ptext(p))) !== JSON.stringify(d.main.blocks.map(p => D.ptext(p)))) throw new Error('Saving changed carriage-return text or offsets');
  return { artifacts };
}
