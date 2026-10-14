// Every piece of editable text maps to the document, and a click on it puts the caret there (the class of fault
// behind Quire's diagram labels that took no caret). Check 1 sweeps the page (tests/lib/textmap.mjs, no input);
// check 2 clicks into text of each kind with real input: the caret is at the clicked character, and a letter typed
// goes there. On generated documents with every kind of text; tools/textmap-corpus.mjs runs check 1 over a corpus.
//
//   node --test --test-concurrency=1 tests/ui/textmap.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, pause } from '../lib/input.mjs';
import { SWEEP } from '../lib/textmap.mjs';

/* ---------------------------------------------------------------- Quire */
/** the welcome document with each diagram of the gallery, a floating text box and a shape with text */
async function quireDoc() {
  const t = await open('quire', { look: 'classic' });
  await t.evaluate(`L.app.newDocument({ build: (d) => Object.assign(d, L.app.buildSample()) })`); await pause(400);
  for (const kind of ['Pyramid Diagram', 'Organization Chart', 'Cycle Diagram']) {
    await t.evaluate(`(() => { const p = L.D.doc.main.blocks.filter((b) => b.t === 'p' && L.D.ptext(b).length > 20)[1]; L.ed.setSel(L.D.pos(p, L.D.plen(p))); L.ed.focus(); })()`);
    await t.evaluate(`L.ui.exec('insertDiagram')`); await pause(400);
    await t.click(await t.el(`.dlg [aria-label="${kind}"]`)); await t.click(await t.el('.dlg .dlg-foot .btn.primary')); await pause(600);
  }
  await t.evaluate(`(async () => { const D = L.D, d = D.doc, p = d.main.blocks.find((b) => b.t === 'p' && D.ptext(b).length > 20);
    const box = L.drawing.newShape('rect', 160, 60, { textbox: true }); box.tb.blocks = [D.para([D.text('Floating text box words')])];
    L.drawing.setWrap(box, 'square'); box.float.posH = { rel: 'page', off: 380 }; box.float.posV = { rel: 'page', off: 520 };
    const shp = L.drawing.newShape('ellipse', 150, 70); shp.tb = { kind: 'tb', blocks: [D.para([D.text('Shape with words')])] };
    L.ed.setSel(D.pos(p, 0)); L.ed.edit('Insert', () => L.O.insertItem(L.ed.sel.f, box));
    L.ed.setSel(D.pos(p, D.plen(p))); L.ed.edit('Insert', () => L.O.insertItem(L.ed.sel.f, shp));
    await new Promise((r) => setTimeout(r, 500)); })()`);
  return t;
}
test('Quire, check 1: every editable text node maps to a paragraph of the document and back', { timeout: 300000 }, async () => {
  const t = await quireDoc();
  try {
    const r = await t.evaluate(SWEEP.quire);
    for (const k of ['body', 'cell', 'group', 'textbox']) assert.ok(r.kinds[k] > 0, `setup: text of kind ${k}`);
    assert.deepEqual(r.findings, []);
    t.clean();
  } finally { await t.close(); }
});
test('Quire, check 2: a click in text of each kind puts the caret at the character, and typing goes there', { timeout: 300000 }, async () => {
  const t = await quireDoc();
  try {
    /* the candidates as document positions: the page is drawn again after each click's Undo */
    const cands = await t.evaluate(`(() => { const by = {}, out = [];
      const where = (e) => e.closest('.shp.sgrp') ? 'group' : e.closest('.tbx') ? 'textbox' : e.closest('td') ? 'cell' : 'body';
      const w = document.createTreeWalker(L.layout.root, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { const e = n.parentElement; if (!e.isContentEditable || n.length < 6 || !e.getClientRects().length || e.closest('a, [data-link], [data-fid]')) continue;
        const mid = Math.floor(n.length / 2); if (!/^[A-Za-z]{3}$/.test(n.data.slice(mid - 1, mid + 2))) continue;
        const k = where(e), pos = L.layout.domToPos(n, mid); if (!pos) continue;
        by[k] = (by[k] || 0) + 1; if (by[k] <= 2) out.push({ k, pid: pos.p.id, o: pos.o }); }
      return out; })()`);
    const bad = [], kinds = new Set();
    for (const cand of cands) {
      const c = await t.evaluate(`(() => { const p = L.D.byId(L.D.doc, ${cand.pid}), m = p && L.layout.posToDom(L.D.pos(p, ${cand.o})); if (!m) return null;
        (m.node.nodeType === 3 ? m.node.parentElement : m.node).scrollIntoView({ block: 'center' });
        const r = document.createRange(); r.setStart(m.node, m.offset); r.setEnd(m.node, Math.min(m.offset + 1, m.node.length || 0)); const b = r.getBoundingClientRect();
        return { x: b.left + Math.max(1, b.width * 0.2), y: b.top + b.height / 2, text: L.D.ptext(p), ctx: L.D.ptext(p).slice(${cand.o} - 8, ${cand.o} + 8) }; })()`);
      if (!c) { bad.push(`${cand.k}: the position no longer maps to the page`); continue; }
      kinds.add(cand.k);
      await pause(80); await t.click(c); await pause(150);
      const got = await t.evaluate(`(() => { L.ed.syncSel(); const s = L.ed.sel; return s && { pid: s.f.p.id, o: s.f.o, obj: !!L.ed.objSel }; })()`);
      let verdict = null;
      if (!got || got.obj || got.pid !== cand.pid || Math.abs(got.o - cand.o) > 1) verdict = 'caret ' + JSON.stringify(got) + ', wanted ' + JSON.stringify([cand.pid, cand.o]);
      else {
        await t.type('Q'); await pause(80);
        const after = await t.evaluate(`L.D.ptext(L.D.byId(L.D.doc, ${cand.pid}))`);
        if (after !== c.text.slice(0, got.o) + 'Q' + c.text.slice(got.o)) verdict = 'typing went elsewhere';
        await t.evaluate(`L.ui.exec('undo')`); await pause(120);
      }
      if (verdict) bad.push(`${cand.k} "${c.ctx}": ${verdict}`);
    }
    assert.deepEqual([...kinds].sort(), ['body', 'cell', 'group', 'textbox'], 'setup: clicks in every kind of text');
    assert.deepEqual(bad, []);
    t.clean();
  } finally { await t.close(); }
});

/* ---------------------------------------------------------------- Lectern */
/** the sample deck (title, text boxes, groups, a table, a diagram) and a slide with a gallery diagram, its nodes named */
async function lecternDeck() {
  const t = await open('lectern', { look: 'classic' });
  await t.evaluate(`L.app.loadSample()`); await pause(600);
  await t.evaluate(`(() => { L.ed.goto(L.pres.slides.length - 1); L.ui.exec('newSlide'); L.ed.goto(L.pres.slides.length - 1); L.diagram.insert(L.smartart.LAYOUTS[0].id);
    const g = L.ed.slide().shapes.find((s) => s.type === 'group'); let i = 0; const rec = (k) => k.forEach((s) => { if (s.kids) rec(s.kids); else if (s.tx) s.tx.ps = [L.txt.para('Node number ' + (++i))]; }); rec(g.kids); L.ed.render(); })()`);
  await pause(400);
  return t;
}
test('Lectern, check 1: the text of every shape, cell and diagram node maps to its model and back while edited', async () => {
  const t = await lecternDeck();
  try {
    const r = await t.evaluate(SWEEP.lectern);
    for (const k of ['placeholder', 'textbox', 'group', 'shape', 'cell', 'diagram']) assert.ok(r.kinds[k] > 0, `setup: text of kind ${k}`);
    assert.deepEqual(r.findings, []);
    t.clean();
  } finally { await t.close(); }
});
/** click (spaced, not a double-click) at the middle of a word of each shape's text on slides until it is edited; per
    shape: the caret at the clicked character and a letter typed there; returns what went wrong, and the kinds seen */
async function lecternClicks(t, kindsWanted) {
  const bad = [], kinds = new Set();
  const nSlides = await t.evaluate('L.pres.slides.length');
  for (let si = 0; si < nSlides; si++) {
    await t.evaluate(`(() => { if (L.te.active()) L.te.end(); L.ed.goto(${si}); L.ed.select([]); })()`); await pause(400);
    const targets = await t.evaluate(`(() => { const E = L.ed, out = [];
      const rec = (shapes, parent) => { for (const sh of shapes) { if (sh.type === 'group') { rec(sh.kids || [], sh); continue; }
        const kind = parent ? (parent.sa ? 'diagram' : 'group') : sh.type === 'table' ? 'cell' : sh.ph ? 'placeholder' : sh.type === 'text' ? 'textbox' : sh.type === 'shape' ? 'shape' : null;
        if (!kind || !${JSON.stringify(kindsWanted)}.includes(kind)) continue;
        const el = E.elOf(sh.id); if (!el) continue;
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
        while ((n = w.nextNode())) { const m = /[A-Za-z]{5,}/.exec(n.data); if (!m) continue; const k = m.index + 2;
          const r = document.createRange(); r.setStart(n, k); r.setEnd(n, k + 1); const b = r.getBoundingClientRect(), x = b.left + b.width * 0.3, y = b.top + b.height / 2;
          const top = document.elementFromPoint(x, y); if (!top || !el.contains(top)) continue;
          out.push({ id: sh.id, kind, word: m[0], k: m.index + 2, x, y }); break; } } };
      rec(E.slide().shapes, null); return out; })()`);
    for (const g of targets) {
      kinds.add(g.kind);
      await t.evaluate(`(() => { if (L.te.active()) L.te.end(); L.ed.select([]); })()`); await pause(700);
      let clicks = 0;
      while (clicks < 3) { await t.click(g); clicks++; await pause(650); if (await t.evaluate(`L.te.active() && L.te.target().sh.id === ${JSON.stringify(g.id)}`)) break; }
      const st = await t.evaluate(`(() => { if (!L.te.active() || L.te.target().sh.id !== ${JSON.stringify(g.id)}) return null; const s = L.te.getSel(); return s && { s, text: L.txt.paraText(L.te.target().tx.ps[s.p0]) }; })()`);
      if (!st) { bad.push(`${g.kind} "${g.word}": not edited after ${clicks} clicks`); continue; }
      const at = st.text.indexOf(g.word) + 2;
      if (Math.abs(st.s.o0 - at) > 1) { bad.push(`${g.kind} "${g.word}": caret at ${st.s.o0}, the click was at ${at}`); continue; }
      await t.type('Q'); await pause(150);
      const after = await t.evaluate(`L.txt.paraText(L.te.target().tx.ps[${st.s.p0}])`);
      if (after !== st.text.slice(0, st.s.o0) + 'Q' + st.text.slice(st.s.o0)) bad.push(`${g.kind} "${g.word}": typing went elsewhere`);
      await t.key('Escape'); await pause(100); await t.evaluate(`L.ui.exec('undo')`); await pause(200);
    }
  }
  return { bad, kinds: [...kinds].sort() };
}
test('Lectern, check 2: clicks into a placeholder, a text box, a shape and a group\'s shape put the caret at the character', async () => {
  const t = await lecternDeck();
  try {
    const r = await lecternClicks(t, ['placeholder', 'textbox', 'shape', 'group']);
    assert.deepEqual(r.kinds, ['group', 'placeholder', 'shape', 'textbox'], 'setup');
    assert.deepEqual(r.bad, []);
    t.clean();
  } finally { await t.close(); }
});
test('Lectern, check 2: clicks into a table cell and a diagram\'s node put the caret at the character', { todo: 'T1: the slide moves when the Tables or Diagram toolbar comes' }, async () => {
  const t = await lecternDeck();
  try {
    const r = await lecternClicks(t, ['cell', 'diagram']);
    assert.deepEqual(r.kinds, ['cell', 'diagram'], 'setup');
    assert.deepEqual(r.bad, []);
    t.clean();
  } finally { await t.close(); }
});

/* ---------------------------------------------------------------- Ledger */
/** a Ledger text box holding "Hello wonderful world", not selected; the point of the "d" of "wonderful", and its edge */
async function ledgerTextBox(t) {
  await t.evaluate(`L.drawing.insertShape('textbox', { x: 300, y: 260, w: 260, h: 90 })`); await pause(400);
  await t.type('Hello wonderful world'); await t.esc(); await pause(150); await t.esc(); await pause(150);
  await t.click(await t.evaluate(`(() => { const w = document.querySelector('#gridwrap').getBoundingClientRect(), b = L.grid.cellRect(1, 1); return { x: w.left + b.x + 5, y: w.top + b.y + 5 }; })()`)); await pause(300);
  return t.evaluate(`(() => { const w = document.createTreeWalker(document.querySelector('#glayer'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.data.includes('wonderful')) { const k = n.data.indexOf('wonderful') + 3, r = document.createRange(); r.setStart(n, k); r.setEnd(n, k + 1); const b = r.getBoundingClientRect(), box = document.querySelector('#glayer .gobj').getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2, edge: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + 1) } }; } return null; })()`);
}
test('Ledger: a text box\'s edge shows the move cursor and a drag on it moves the box; a double-click selects the word', async () => {
  const t = await open('ledger', { look: 'classic' });
  try {
    const p = await ledgerTextBox(t);
    assert.equal(await t.evaluate(`getComputedStyle(document.elementFromPoint(${p.edge.x}, ${p.edge.y})).cursor`), 'move', 'the edge');
    const before = await t.evaluate(`JSON.stringify(L.grid.sheet().drawings[0].anchor)`);
    await t.drag(p.edge, { x: p.edge.x + 40, y: p.edge.y + 30 }, 6); await pause(200);
    assert.notEqual(await t.evaluate(`JSON.stringify(L.grid.sheet().drawings[0].anchor)`), before, 'moved');
    assert.equal(await t.evaluate(`L.grid.sheet().drawings[0].text`), 'Hello wonderful world', 'its text as it was');
    const q = await t.evaluate(`(() => { const w = document.createTreeWalker(document.querySelector('#glayer'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.data.includes('wonderful')) { const k = n.data.indexOf('wonderful') + 3, r = document.createRange(); r.setStart(n, k); r.setEnd(n, k + 1); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } })()`);
    await t.click(await t.evaluate(`(() => { const w = document.querySelector('#gridwrap').getBoundingClientRect(), b = L.grid.cellRect(1, 1); return { x: w.left + b.x + 5, y: w.top + b.y + 5 }; })()`)); await pause(700);
    await t.dblclick(q); await pause(300);
    assert.equal(await t.evaluate('String(getSelection()).trim()'), 'wonderful', 'the double-clicked word is selected');
    await t.type('great'); await t.esc(); await pause(200);
    assert.equal(await t.evaluate(`L.grid.sheet().drawings[0].text`), 'Hello great world');
    t.clean();
  } finally { await t.close(); }
});
test('Ledger, check 2: a click on a text box\'s word puts the caret there, and typing goes there', async () => {
  const t = await open('ledger', { look: 'classic' });
  try {
    const p = await ledgerTextBox(t);
    assert.equal(await t.evaluate(`getComputedStyle(document.elementFromPoint(${p.x}, ${p.y})).cursor`), 'text', 'the text cursor over the text');
    await t.click(p); await pause(300);
    await t.type('Q'); await t.esc(); await pause(200);
    assert.equal(await t.evaluate(`L.grid.sheet().drawings[0].text`), 'Hello wonQderful world');
    t.clean();
  } finally { await t.close(); }
});
test('Ledger: a click on the text of an AutoShape already selected puts the caret there; on one not selected it selects it', async () => {
  const t = await open('ledger', { look: 'classic' });
  try {
    await t.evaluate(`L.drawing.insertShape('rect', { x: 300, y: 260, w: 260, h: 90 })`); await pause(400);
    await t.type('Hello wonderful world'); await t.esc(); await pause(150);
    const cell = await t.evaluate(`(() => { const w = document.querySelector('#gridwrap').getBoundingClientRect(), b = L.grid.cellRect(1, 1); return { x: w.left + b.x + 5, y: w.top + b.y + 5 }; })()`);
    await t.click(cell); await pause(700);
    const p = await t.evaluate(`(() => { const w = document.createTreeWalker(document.querySelector('#glayer'), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.data.includes('wonderful')) { const k = n.data.indexOf('wonderful') + 3, r = document.createRange(); r.setStart(n, k); r.setEnd(n, k + 1); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } })()`);
    await t.click(p); await pause(700);
    assert.equal(await t.evaluate(`!!L.grid.selectedObject() && !document.querySelector('#glayer .editing')`), true, 'the first click selects it');
    await t.click(p); await pause(300);
    await t.type('Q'); await t.esc(); await pause(200);
    assert.equal(await t.evaluate(`L.grid.sheet().drawings[0].text`), 'Hello wonQderful world');
    t.clean();
  } finally { await t.close(); }
});
