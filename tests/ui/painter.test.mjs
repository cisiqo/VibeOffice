// The Format Painter in Quire, Ledger and Lectern with real mouse input (tests/lib/input.mjs): it paints what the
// user marks, once, when the mouse is let go (never while a selection is still being dragged out); a click on its
// button arms it for one use, a double-click keeps it on until Esc; starting it keeps the selection or the text being
// edited (common/ui.js, ui.brush; docs/suite.md, Brushes).
//
//   node --test --test-concurrency=1 tests/ui/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../lib/input.mjs';

test('Quire: paints the dragged text, a clicked word; locks on a double-click; keeps links', async () => {
  const q = await open('quire');
  try {
    /** screen point just inside the character at offset o of block b */
    const at = (b, o) => q.evaluate(`(() => { const p = L.D.doc.main.blocks[${b}], m = L.layout.posToDom(L.D.pos(p, ${o})), r = document.createRange();
      r.setStart(m.node, m.offset); r.collapse(true); const box = r.getClientRects()[0] || r.getBoundingClientRect(); return { x: box.left + 1, y: box.top + box.height / 2 }; })()`);
    const runs = (b) => q.evaluate(`L.D.doc.main.blocks[${b}].runs.map((r) => [r.text, !!(r.rPr && r.rPr.b)])`);
    const load = () => q.evaluate(`(async () => {
      const { D } = L, d = D.newDoc();
      d.main.blocks = [D.para([D.text('Source', { b: true }), D.text(' plain target words follow here')]),
        D.para([D.text('Second paragraph of '), D.text('linked', { link: { url: 'https://example.com/' } }), D.text(' text for clicking')]),
        D.para([D.text('Third paragraph with more words to paint')])];
      L.app.loadDoc(d, 'Painter');
      await new Promise((r) => setTimeout(r, 500));
      const p = d.main.blocks[0]; L.ed.setSel(D.pos(p, 2), D.pos(p, 2));
    })()`);

    await load();
    await q.click(await q.button('painter'));
    assert.equal(await q.painting(), true, 'a click arms the painter');
    await q.drag(await at(0, 13), await at(0, 25));
    assert.deepEqual(await runs(0), [['Source', true], [' plain ', false], ['target words', true], [' follow here', false]], 'the whole drag is painted');
    assert.equal(await q.painting(), false, 'one use, then off');

    await load();
    await q.click(await q.button('painter'));
    await q.click(await at(2, 9));
    assert.deepEqual(await runs(2), [['Third ', false], ['paragraph', true], [' with more words to paint', false]], 'a click paints the word');

    await q.esc();
    await load();
    await q.dblclick(await q.button('painter'));
    assert.equal(await q.painting(), true, 'a double-click arms the painter');
    await q.drag(await at(1, 20), await at(1, 26));
    assert.equal(await q.painting(), true, 'and keeps it on');
    await q.drag(await at(2, 6), await at(2, 15));
    assert.deepEqual(await runs(1), [['Second paragraph of ', false], ['linked', true], [' text for clicking', false]], 'first use');
    assert.equal(await q.evaluate(`L.D.doc.main.blocks[1].runs[1].rPr.link.url`), 'https://example.com/', 'the painted link stays a link');
    assert.deepEqual(await runs(2), [['Third ', false], ['paragraph', true], [' with more words to paint', false]], 'second use');
    await q.esc();
    assert.equal(await q.painting(), false, 'Esc ends it');

    /* Copy Formatting / Paste Formatting (Ctrl+Shift+C, Ctrl+Shift+V): no brush, pastes as often as asked */
    await load();
    await q.key('C', { ctrl: true, shift: true });
    assert.equal(await q.painting(), false, 'Copy Formatting arms no brush');
    for (const [b, o0, o1] of [[1, 0, 6], [2, 0, 5]]) {
      await q.evaluate(`(() => { const p = L.D.doc.main.blocks[${b}]; L.ed.setSel(L.D.pos(p, ${o0}), L.D.pos(p, ${o1})); })()`);
      await q.key('V', { ctrl: true, shift: true });
    }
    assert.deepEqual((await runs(1))[0], ['Second', true], 'first paste');
    assert.deepEqual((await runs(2))[0], ['Third', true], 'second paste');
    q.clean();
  } finally { await q.close(); }
});

test('Ledger: paints the dragged cells; locks on a double-click; Esc ends it', async () => {
  const g = await open('ledger');
  try {
    const cell = (r, c) => g.evaluate(`(() => { const w = document.querySelector('#gridwrap').getBoundingClientRect(), b = L.grid.cellRect(${r}, ${c}); return { x: w.left + b.x + b.w / 2, y: w.top + b.y + b.h / 2 }; })()`);
    /** B where a cell has A1's (bold) style, rows 0-5 by columns 0-4 */
    const bold = () => g.evaluate(`(() => { const sh = L.grid.sheet(), s = sh.get(0, 0).s, out = []; for (let r = 0; r < 6; r++) { let row = ''; for (let c = 0; c < 5; c++) { const cl = sh.get(r, c); row += cl && cl.s === s ? 'B' : '.'; } out.push(row); } return out.join(' '); })()`);
    await g.evaluate(`L.grid.select(0, 0); L.ui.exec('bold')`);
    await g.click(await g.button('formatPainter'));
    assert.equal(await g.painting(), true, 'a click arms the painter');
    await g.drag(await cell(2, 2), await cell(4, 3));
    assert.equal(await bold(), 'B.... ..... ..BB. ..BB. ..BB. .....', 'the dragged range is painted');
    assert.equal(await g.painting(), false, 'one use, then off');

    await g.evaluate(`L.grid.select(0, 0)`);
    await g.dblclick(await g.button('formatPainter'));
    assert.equal(await g.painting(), true, 'a double-click arms the painter');
    await g.click(await cell(0, 4));
    assert.equal(await g.painting(), true, 'and keeps it on');
    await g.drag(await cell(5, 0), await cell(5, 1));
    assert.equal(await bold(), 'B...B ..... ..BB. ..BB. ..BB. BB...', 'two uses');
    await g.esc();
    assert.equal(await g.painting(), false, 'Esc ends it');
    g.clean();
  } finally { await g.close(); }
});

test('Lectern: keeps text editing; paints dragged text, a clicked word, another box\'s text, a whole shape', async () => {
  const s = await open('lectern');
  try {
    await s.evaluate(`(async () => {
      const E = L.ed, M = L.model, slide = L.pres.slides[E.idx];
      const box = (id, y, rs) => { const b = M.newTextBox(L.pres, slide, 60, y, 520, 40, true); b.id = id; b.tx.ps = [{ lvl: 0, pp: {}, rs }]; return b; };
      const rect = (id, x, v) => { const r = M.newShape(L.pres, slide, 'rect', x, 400, 150, 80); r.id = id; r.fill = { t: 'solid', c: v, a: 1 }; return r; };
      slide.shapes = [box('boxA', 60, [{ t: 'Source', b: true, color: '#C00000', link: { url: 'https://example.com/' } }, { t: ' plain target words follow here' }]),
        box('boxB', 160, [{ t: 'Another box with words to paint', i: true }]), rect('red', 60, '#FF0000'), rect('blue', 300, '#0000FF')];
      E.sel = []; E.render();
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    /** screen point of character n of a shape's text */
    const at = (id, n) => s.evaluate(`(() => { const w = document.createTreeWalker(L.ed.elOf('${id}'), NodeFilter.SHOW_TEXT); let k = ${n}, t;
      while ((t = w.nextNode())) { if (k <= t.length) { const r = document.createRange(); r.setStart(t, k); r.collapse(true); const b = r.getClientRects()[0] || r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } k -= t.length; } })()`);
    const centre = (id) => s.evaluate(`(() => { const r = L.ed.elOf('${id}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    /** [text, bold, italic, linked] for each run */
    const runs = (id) => s.evaluate(`L.ed.shape('${id}').tx.ps[0].rs.map((r) => [r.t, !!r.b, !!r.i, !!r.link])`);
    const state = async () => ({ editing: await s.evaluate('L.te.state && L.te.state.id'), painter: await s.painting() });
    const painter = await s.button('painter');

    await s.click(await at('boxA', 2));
    await s.click(await at('boxA', 2));
    await s.click(painter);
    assert.deepEqual(await state(), { editing: 'boxA', painter: true }, 'the painter keeps the text being edited');
    await s.drag(await at('boxA', 13), await at('boxA', 25));
    assert.deepEqual(await runs('boxA'), [['Source', true, false, true], [' plain ', false, false, false], ['target words', true, false, false], [' follow here', false, false, false]],
      'the dragged text is painted, without the source\'s link');
    assert.deepEqual(await state(), { editing: 'boxA', painter: false }, 'one use; still editing');

    await s.click(painter);
    await s.click(await at('boxB', 19));
    assert.deepEqual(await runs('boxB'), [['Another box with ', false, true, false], ['words', true, false, false], [' to paint', false, true, false]],
      'a click on a word in another box paints the word, replacing its italic');
    assert.equal((await state()).editing, 'boxB', 'that box is edited');

    await s.dblclick(painter);
    assert.deepEqual(await state(), { editing: 'boxB', painter: true }, 'a double-click arms the painter');
    await s.drag(await at('boxB', 0), await at('boxB', 7));
    assert.equal(await s.painting(), true, 'and keeps it on');
    await s.click(await at('boxA', 10));
    assert.deepEqual((await runs('boxB'))[0], ['Another', true, false, false], 'first use');
    assert.deepEqual((await runs('boxA'))[2], ['plain', true, false, false], 'second use, in another box');
    await s.esc();
    assert.deepEqual(await state(), { editing: 'boxA', painter: false }, 'Esc puts the painter down and keeps the text being edited');

    await s.click(await centre('red'));
    await s.click(painter);
    await s.click(await centre('blue'));
    assert.equal(await s.evaluate(`L.ed.shape('blue').fill.c`), '#FF0000', 'a click on a shape paints the whole shape');
    assert.deepEqual(await s.evaluate('L.ed.sel'), ['blue'], 'the painted shape is selected');
    assert.equal(await s.painting(), false, 'one use');

    await s.click(await centre('red'));
    await s.dblclick(painter);
    const empty = await s.evaluate(`(() => { const r = L.ed.host.getBoundingClientRect(); return { x: r.left + r.width - 20, y: r.top + 20 }; })()`);
    await s.click(empty);
    assert.equal(await s.painting(), false, 'a click beside the objects puts even a kept-on painter down');
    s.clean();
  } finally { await s.close(); }
});

test('Esc in the middle of a painting drag cancels it and puts the painter down (Ledger, Lectern)', async () => {
  const g = await open('ledger');
  try {
    const cell = (r, c) => g.evaluate(`(() => { const w = document.querySelector('#gridwrap').getBoundingClientRect(), b = L.grid.cellRect(${r}, ${c}); return { x: w.left + b.x + b.w / 2, y: w.top + b.y + b.h / 2 }; })()`);
    const painted = () => g.evaluate(`(() => { const sh = L.grid.sheet(), s = sh.get(0, 0).s; let n = 0; for (let r = 1; r < 12; r++) for (let c = 0; c < 6; c++) { const cl = sh.get(r, c); if (cl && cl.s === s) n++; } return n; })()`);
    await g.evaluate(`L.grid.select(0, 0); L.ui.exec('bold')`);
    await g.click(await g.button('formatPainter'));
    const a = await cell(3, 3), b = await cell(6, 5);
    await g.press(a); await g.glide(a, b, 5); await g.esc(); await g.release(b);
    assert.equal(await g.painting(), false, 'Ledger: the painter is down');
    await g.click(await cell(9, 1));
    assert.equal(await painted(), 0, 'Ledger: nothing painted, not even by the next click');
    g.clean();
  } finally { await g.close(); }
  const s = await open('lectern');
  try {
    await s.evaluate(`(async () => {
      const E = L.ed, M = L.model, slide = L.pres.slides[E.idx];
      const rect = (id, x, v) => { const r = M.newShape(L.pres, slide, 'rect', x, 300, 150, 80); r.id = id; r.fill = { t: 'solid', c: v, a: 1 }; return r; };
      slide.shapes = [rect('red', 60, '#FF0000'), rect('blue', 300, '#0000FF')]; E.sel = []; E.render();
      await new Promise((r) => setTimeout(r, 300));
    })()`);
    const centre = (id) => s.evaluate(`(() => { const r = L.ed.elOf('${id}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await s.click(await centre('red'));
    await s.click(await s.button('painter'));
    const c = await centre('blue'), to = { x: c.x + 30, y: c.y + 20 };
    await s.press(c); await s.glide(c, to, 5); await s.esc(); await s.release(to);
    assert.equal(await s.painting(), false, 'Lectern: the painter is down');
    assert.equal(await s.evaluate(`L.ed.shape('blue').fill.c`), '#0000FF', 'Lectern: the shape is not painted');
    s.clean();
  } finally { await s.close(); }
});
