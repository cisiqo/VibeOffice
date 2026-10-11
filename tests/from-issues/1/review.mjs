// Edge-case regressions found while reviewing the issue #1 fixes.
// node tests/from-issues/1/review.mjs OUTPUT [protection|breaks|pagination|marks|print]
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer, openPage } from '../../../tools/ooxml/cdp.mjs';
const [output, filter] = process.argv.slice(2);
if (!output) throw new Error('Usage: node tests/from-issues/1/review.mjs OUTPUT [protection|breaks|pagination|marks|print]');
fs.mkdirSync(output, { recursive: true });
const stop = await ensureServer(), results = [];
try {
  for (const [name, app, fn] of [['protection', 'ledger', protection], ['breaks', 'quire', breaks], ['pagination', 'quire', pagination], ['marks', 'quire', marks], ['print', 'quire', printMarks]]) {
    if (filter && filter !== name) continue;
    const page = await openPage(app, { persistence: false });
    try {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.evaluate('VO.opened = () => {}; document.fonts.ready');
      if (app === 'quire') await page.evaluate('L.layout.view = "print"; L.layout.setZoom(1)');
      const value = await page.evaluate(`(${fn.toString()})()`);
      for (const [file, data] of Object.entries(value?.artifacts || {})) fs.writeFileSync(path.join(output, file), Buffer.from(data, 'base64'));
      if (name === 'print') {
        await page.send('Emulation.setEmulatedMedia', { media: 'print' });
        await page.evaluate(`(() => {
          for (const e of document.querySelectorAll('.format-marks, .sectmark, .hbrk')) if (getComputedStyle(e).display !== 'none') throw new Error('Formatting marker appears in print');
          for (const e of document.querySelectorAll('.tb')) if (!['none', 'normal'].includes(getComputedStyle(e, '::before').content)) throw new Error('Tab arrow appears in print');
        })()`);
      }
      if (page.errors.length || page.requests.length) throw new Error(JSON.stringify({ errors: page.errors, requests: page.requests }));
      results.push({ name, status: 'ok' });
    } catch (error) {
      results.push({ name, status: 'failed', error: error.message }); process.exitCode = 1;
    } finally {
      try {
        const shot = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
      } finally { await page.close(); }
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally { stop(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2)); }

function protection() {
  const { app: A, grid: G, ops: O } = L;
  const original = L.ui.msg, notices = [];
  L.ui.msg = message => notices.push(message);
  try {
    for (const dir of ['down', 'right']) for (const mode of ['blank-locked', 'distant-locked', 'unlocked']) {
      const down = dir === 'down', last = mode === 'distant-locked' ? (down ? 602 : 102) : 2;
      A.addBook(A.blankWorkbook(), 'Protected fill', { untitled: true });
      const sh = G.sheet(), unlocked = G.wb.styles.add({ prot: { locked: false } });
      O.enter(sh, 0, 0, '7'); sh.get(0, 0).s = unlocked;
      if (mode !== 'blank-locked') for (let i = 1; i <= last; i++) O.put(sh, down ? i : 0, down ? 0 : i, { s: mode === 'distant-locked' && i === last ? 0 : unlocked });
      sh.protection = { attrs: { sheet: '1' } };
      G.select(0, 0); G.extendTo(down ? last : 0, down ? 0 : last);
      notices.length = 0; A.fillDir(dir);
      for (let i = 1; i <= last; i++) {
        const value = sh.val(down ? i : 0, down ? 0 : i);
        if (mode === 'unlocked' ? value !== 7 : value != null) throw new Error(`${dir}/${mode}: fill changed the wrong cells at ${i}`);
      }
      if ((mode === 'unlocked') === !!notices.length) throw new Error(`${dir}/${mode}: wrong protection notice`);
      if (mode === 'unlocked') { A.undo(); if (sh.val(down ? last : 0, down ? 0 : last) != null) throw new Error('Protected fill undo failed'); }
    }
  } finally { L.ui.msg = original; }
}

async function breaks() {
  const { D, O, layout: LY } = L, artifacts = {};
  const save = async (name, blob) => { const bytes = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768)); artifacts[name] = btoa(s); };
  const base = await L.docx.write(D.newDoc()), zip = await L.zip.read(new Uint8Array(await base.arrayBuffer()));
  const files = await Promise.all(Array.from(zip, async ([name, entry]) => ({ name, data: await entry.bytes() })));
  const main = files.find(f => f.name === 'word/document.xml');
  const run = (text, bold = false) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const paragraphs = [
    run('First&#13;&#10;Second&#13;&#10;Third'),
    run('First&#13;', true) + run('&#10;Second&#13;&#10;Third'),
    run('First&#13;') + '<w:bookmarkStart w:id="1" w:name="BreakPair"/>' + run('&#10;Second&#13;&#10;Third', true) + '<w:bookmarkEnd w:id="1"/>',
    run('First&#13;') + '<w:sdt><w:sdtPr><w:id w:val="123"/><w:text/></w:sdtPr><w:sdtContent>' + run('&#10;Second&#13;') + '</w:sdtContent></w:sdt>' + run('&#10;Third'),
  ].map(s => '<w:p>' + s + '</w:p>').join('');
  main.data = L.zip.decode(main.data).replace(/<w:body>[\s\S]*?<w:sectPr/, '<w:body>' + paragraphs + '<w:sectPr');
  const original = await L.zip.write(files); await save('split-crlf-original.docx', original);
  const d = (await L.docx.read(new Uint8Array(await original.arrayBuffer()))).doc;
  L.app.loadDoc(d, 'Split CRLF', { saved: true });
  const check = doc => {
    if (D.doc !== doc) L.app.loadDoc(doc, 'Split CRLF', { saved: true });
    else LY.render();
    for (const [index, p] of doc.main.blocks.entries()) {
      const tops = ['First', 'Second', 'Third'].map(text => {
        const pos = LY.posToDom(D.pos(p, D.ptext(p).indexOf(text))), range = document.createRange();
        range.setStart(pos.node, pos.offset); range.setEnd(pos.node, pos.offset + 1); return range.getBoundingClientRect().top;
      });
      const line = tops[2] - tops[1];
      if (line <= 0 || Math.abs(tops[1] - tops[0] - line) > 0.5) throw new Error(`Paragraph ${index}: a split CRLF creates an extra line: ${tops}`);
    }
  };
  check(d);
  const saved = await L.docx.write(d); await save('split-crlf-saved.docx', saved);
  check((await L.docx.read(new Uint8Array(await saved.arrayBuffer()))).doc);
  L.app.loadDoc(d, 'Split CRLF', { saved: true });
  const p = d.main.blocks[0];
  D.tx('Format through CR', () => O.setRunProps(D.pos(p, 0), D.pos(p, 6), { b: true }));
  check(d); await save('split-crlf-edited.docx', await L.docx.write(d));
  if (!D.undo()) throw new Error('Formatting undo failed'); check(d);
  if (!D.redo()) throw new Error('Formatting redo failed'); check(d);
  return { artifacts };
}

function pagination() {
  const { D, layout: LY } = L;
  for (const jc of ['left', 'center', 'right']) {
    let expected;
    for (const kind of ['br', 'cr', 'crlf', 'cr-split', 'crlf-split']) {
      const d = D.newDoc(); d.sect.pgH = 140; d.sect.mt = 10; d.sect.mb = 10;
      const labels = Array.from({ length: 20 }, (_, i) => i % 2 ? 'X' : 'ABCDEFGHIJ');
      const separator = kind.startsWith('crlf') ? '\r\n' : '\r';
      const runs = kind === 'br' ? labels.flatMap((text, i) => i ? [D.item('br', { type: 'line' }), D.text(text)] : [D.text(text)]) : kind.endsWith('-split') ? labels.map((text, i) => D.text(text + (i < labels.length - 1 ? separator : ''), { color: i % 2 ? '000001' : '000000' })) : [D.text(labels.join(separator))];
      d.main.blocks = [D.para(runs, { jc, widow: false })];
      L.app.loadDoc(d, 'Forced line pagination', { saved: true });
      const pages = LY.pages.map(pg => pg.body.textContent.replace(/[\r\n\u200b]/g, ''));
      if (kind === 'br') expected = pages;
      else if (JSON.stringify(pages) !== JSON.stringify(expected)) throw new Error(`${jc}/${kind}: forced lines paginate differently: ${JSON.stringify({ expected, pages })}`);
    }
  }
}

function marks() {
  const { D, layout: LY } = L, d = D.newDoc();
  const tb = { kind: 'tb', id: 'marks-review', blocks: [D.para([D.text('Alpha beta gamma')])] };
  const vertical = D.simpleTable(1, 1, 120); vertical.rows[0].cells[0].tcPr.textDir = 'tbRl'; vertical.rows[0].cells[0].blocks = [D.para([D.text('Vertical text')])];
  d.main.blocks = [D.para([D.text('Hello world')]), D.para([D.text('\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645')], { bidi: true }), D.para([D.item('shape', { geom: 'rect', w: 180, h: 72, rot: 30, tb })]), vertical];
  L.app.loadDoc(d, 'Formatting mark positions', { saved: true });
  LY.opts.showMarks = true; LY.root.classList.add('marks');
  for (const zoom of [0.75, 1, 1.5]) {
    LY.setZoom(zoom); LY.render();
    for (const p of LY.root.querySelectorAll('.p')) {
      const pc = p.firstChild, sp = pc.querySelector(':scope > span[data-o]'), dot = p.querySelector(':scope > .format-marks i'), mark = p.querySelector(':scope > .format-marks .mark-p');
      const text = sp?.firstChild;
      if (text?.nodeType !== 3 || text.data.indexOf(' ') < 0) continue;
      if (!dot || !mark) throw new Error('Missing marks');
      const range = document.createRange(), space = text.data.indexOf(' ');
      range.setStart(text, space); range.setEnd(text, space + 1);
      const r = range.getBoundingClientRect(), m = dot.getBoundingClientRect();
      if (Math.hypot((r.left + r.right - m.left - m.right) / 2, (r.top + r.bottom - m.top - m.bottom) / 2) > 2 * zoom) throw new Error(`Dot is detached from its space: ${text.data}, zoom ${zoom}`);
      range.selectNodeContents(text); const t = range.getBoundingClientRect(), end = mark.getBoundingClientRect(), cs = getComputedStyle(pc);
      if (cs.direction === 'rtl' && end.right > t.left + 1) throw new Error('RTL paragraph mark is at the start of the text');
      if (cs.writingMode === 'vertical-rl' && Math.abs(end.top - t.bottom) > 2 * zoom) throw new Error('Vertical paragraph mark is not at the text end');
    }
  }
}

async function printMarks() {
  const { D, layout: LY } = L, d = D.newDoc();
  const p = D.para([D.text('Left'), D.item('tab'), D.text('Right')]); p.sect = L.clone(d.sect);
  d.main.blocks = [p, D.para([D.text('Next section')])];
  LY.opts.showMarks = false; LY.root.classList.remove('marks');
  L.app.loadDoc(d, 'Nonprinting marks', { saved: true });
  // The thumbnail uses the same rasterization and stylesheet as PDF output.
  const before = (await __corpusHooks.thumb()).toDataURL();
  LY.opts.showMarks = true; LY.root.classList.add('marks'); LY.render();
  if (!LY.root.querySelector('.sectmark')) throw new Error('Missing section-break control');
  const after = (await __corpusHooks.thumb()).toDataURL();
  if (before !== after) throw new Error('Formatting marks change the exported page image');
}
