// The quick check, about a minute: the Start Center and each app load clean (no errors, nothing from outside), and the
// basic round of real input works in each: a click puts the keyboard in the document and typing lands there; a menu
// from the menu bar and a dialog from its shortcut open and close with Esc and give the keyboard back; a drop-down
// inside a dialog opens above it (Ledger); Undo takes the typing back. Run it after every change, with the change's
// own test; the whole of tests/ui/ before a release (docs/testing.md, UI checks):
//
//   node --test --test-concurrency=1 tests/ui/smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, pause } from '../lib/input.mjs';

/** centre of the first visible element matching selector (and text, if given), and whether it is on top there */
const centre = (t, selector, text) => t.evaluate(`(() => {
  const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.getBoundingClientRect().width && (${JSON.stringify(text || '')} === '' || x.textContent.trim() === ${JSON.stringify(text || '')}));
  if (!e) return null; const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
  return { x: Math.round(x), y: Math.round(y), top: !!hit && (hit === e || e.contains(hit)) }; })()`);
const menus = (t) => t.evaluate(`document.querySelectorAll('.menu').length`);
const dialogs = (t) => t.evaluate(`document.querySelectorAll('.dlg').length`);

/** the menu bar's File menu opens on a click and Esc closes it; the shortcut's dialog opens and Esc closes it */
async function menuAndDialog(t, shortcut) {
  await t.click(await centre(t, '.mb-item', 'File'));
  assert.ok(await menus(t), 'File menu open');
  await t.esc(); await pause(150);
  assert.equal(await menus(t), 0, 'Esc closes the menu');
  await t.key(...shortcut); await pause(300);
  assert.equal(await dialogs(t), 1, 'the shortcut opens its dialog');
  await t.esc(); await pause(200);
  assert.equal(await dialogs(t), 0, 'Esc closes the dialog');
}

test('Start Center loads clean', async () => {
  const t = await open('', { look: 'classic' });
  try {
    assert.ok(await centre(t, 'button, a', 'Quire') || await t.evaluate(`/Quire/.test(document.body.textContent)`), 'the apps are offered');
    t.clean();
  } finally { await t.close(); }
});

test('Quire: type, a menu, a dialog, Undo', async () => {
  const t = await open('quire', { look: 'classic' });
  try {
    await t.evaluate(`(async () => { const { D } = L, d = D.newDoc(); d.main.blocks = [D.para([D.text('Plain text.')])]; L.app.loadDoc(d, 'Smoke'); await new Promise((r) => setTimeout(r, 400)); })()`);
    const text = () => t.evaluate(`L.D.plainText(L.D.doc.main.blocks[0])`);
    const end = await t.evaluate(`(() => { const m = L.layout.posToDom(L.D.pos(L.D.doc.main.blocks[0], 11)), r = document.createRange(); r.setStart(m.node, m.offset); r.collapse(true);
      const b = r.getClientRects()[0] || r.getBoundingClientRect(); return { x: Math.round(b.left + 1), y: Math.round(b.top + b.height / 2) }; })()`);
    await t.click(end);
    await t.type(' One');
    assert.equal(await text(), 'Plain text. One');
    await menuAndDialog(t, ['d', { ctrl: true }]);
    await t.type(' two');
    assert.equal(await text(), 'Plain text. One two', 'the keyboard is back in the document');
    await t.key('z', { ctrl: true }); await pause(200);
    assert.ok(!(await text()).includes('two'), 'Undo takes the typing back');
    t.clean();
  } finally { await t.close(); }
});

test('Ledger: type, a menu, a dialog with a drop-down, Undo', async () => {
  const t = await open('ledger', { look: 'classic' });
  try {
    const cell = (r, c) => t.evaluate(`(() => { const w = document.querySelector('#gridwrap').getBoundingClientRect(), b = L.grid.cellRect(${r}, ${c}); return { x: Math.round(w.left + b.x + b.w / 2), y: Math.round(w.top + b.y + b.h / 2) }; })()`);
    const value = (r, c) => t.evaluate(`L.editor.cellText(L.grid.sheet(), ${r}, ${c})`);
    await t.click(await cell(20, 2));
    await t.type('42'); await t.key('Enter');
    assert.equal(await value(20, 2), '42');
    await menuAndDialog(t, ['1', { ctrl: true }]);
    /* Format Cells ▸ Patterns ▸ Pattern: the swatches open above the dialog */
    await t.key('1', { ctrl: true }); await pause(300);
    await t.click(await centre(t, '.dlg .tab', 'Patterns'));
    await t.click(await centre(t, '.dlg button', 'Pattern'));
    const swatch = await centre(t, '.menu .pat-grid button');
    assert.ok(swatch && swatch.top, 'the drop-down is above the dialog');
    await t.esc(); await pause(150); await t.esc(); await pause(200);
    assert.equal(await dialogs(t), 0, 'Esc closes the drop-down, then the dialog');
    await t.click(await cell(21, 2));
    await t.type('7'); await t.key('Enter');
    assert.equal(await value(21, 2), '7', 'the keyboard is back in the sheet');
    await t.key('z', { ctrl: true }); await pause(200);
    assert.equal(await value(21, 2), '', 'Undo takes the typing back');
    t.clean();
  } finally { await t.close(); }
});

test('Lectern: type, a menu, a dialog, Undo', async () => {
  const t = await open('lectern', { look: 'classic' });
  try {
    await t.evaluate(`(async () => { const E = L.ed, M = L.model; if (L.te.active()) L.te.end(); E.goto(0);
      const slide = L.pres.slides[0], b = M.newTextBox(L.pres, slide, 100, 100, 500, 40, true); b.id = 'boxA'; b.tx.ps = [{ lvl: 0, pp: {}, rs: [{ t: 'Plain text.' }] }];
      slide.shapes = [b]; E.sel = []; E.render(); L.panes.left.render(); await new Promise((r) => setTimeout(r, 300)); })()`);
    const text = () => t.evaluate(`L.ed.elOf('boxA').textContent.replace(/\\u200b/g, '')`);
    const end = () => t.evaluate(`(() => { const w = document.createTreeWalker(L.ed.elOf('boxA'), NodeFilter.SHOW_TEXT); let x, last = null; while ((x = w.nextNode())) if (x.data.replace(/\\u200b/g, '').length) last = x;
      const r = document.createRange(); r.setStart(last, last.length); r.collapse(true); const b = r.getClientRects()[0] || r.getBoundingClientRect(); return { x: Math.round(b.left - 1), y: Math.round(b.top + b.height / 2) }; })()`);
    for (let i = 0; i < 2 && !(await t.evaluate('L.te.active()')); i++) { await t.click(await end()); await pause(150); }
    assert.ok(await t.evaluate('L.te.active()'), 'a click edits the text');
    await t.click(await end());
    await t.type(' One');
    assert.equal(await text(), 'Plain text. One');
    await menuAndDialog(t, ['k', { ctrl: true }]);
    await t.type(' two');
    assert.equal(await text(), 'Plain text. One two', 'the keyboard is back in the text');
    await t.key('z', { ctrl: true }); await pause(200);
    assert.ok(!(await text()).includes('two'), 'Undo takes the typing back');
    t.clean();
  } finally { await t.close(); }
});
