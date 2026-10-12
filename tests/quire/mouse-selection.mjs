// Quire with real mouse input (CDP Input events, paced like a hand): the highlighter applies when the mouse is
// let go, to the whole selection dragged out, as one undo step, and a selected shape's handles go when the user
// clicks into text or presses Esc. The Format Painter is in tests/painter.test.mjs.
// Usage: node tests/quire/mouse-selection.mjs
import assert from 'node:assert/strict';
import { ensureServer, openPage } from '../../tools/ooxml/cdp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stop = await ensureServer();
let page;
try {
  page = await openPage('quire', { persistence: false });
  const { evaluate, send } = page;
  const mouse = (type, x, y, clickCount = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount });
  const click = async ({ x, y }, clickCount = 1) => { await mouse('mousePressed', x, y, clickCount); await pause(50); await mouse('mouseReleased', x, y, clickCount); await pause(300); };
  const drag = async (from, to, steps = 8) => {
    await mouse('mousePressed', from.x, from.y); await pause(60);
    for (let i = 1; i <= steps; i++) { await mouse('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await pause(40); }
    await mouse('mouseReleased', to.x, to.y); await pause(300);
  };
  const key = async (k) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k }); await pause(200); };
  /** screen point just inside the character at offset o of block b */
  const at = (b, o) => evaluate(`(() => { const p = L.D.doc.main.blocks[${b}], m = L.layout.posToDom(L.D.pos(p, ${o})), r = document.createRange();
    r.setStart(m.node, m.offset); r.collapse(true); const box = r.getClientRects()[0] || r.getBoundingClientRect(); return { x: box.left + 1, y: box.top + box.height / 2 }; })()`);
  /** [text, painted] for each run of block b */
  const runs = (b, prop) => evaluate(`L.D.doc.main.blocks[${b}].runs.map(r => [r.text, !!(r.rPr && r.rPr.${prop})])`);
  const load = () => evaluate(`(async () => {
    const { D } = L, d = D.newDoc();
    d.main.blocks = [D.para([D.text('Source', { b: true }), D.text(' plain target words follow here')]),
      D.para([D.text('Second paragraph of ordinary text for clicking')]), D.para([D.text('Third paragraph with more words to paint')])];
    L.app.loadDoc(d, 'Mouse');
    L.ui.brushOn()?.stop();
    await new Promise(r => setTimeout(r, 500));
    const p = d.main.blocks[0]; L.ed.setSel(D.pos(p, 2), D.pos(p, 2));
  })()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

  // highlighter: the whole drag, one undo step
  await load();
  await evaluate(`L.app.applyHighlight('yellow')`);
  const undo0 = await evaluate('L.D.histState().undo.length');
  await drag(await at(0, 7), await at(0, 25));
  assert.deepEqual(await runs(0, 'hl'), [['Source', false], [' ', false], ['plain target words', true], [' follow here', false]], 'the highlighter marks the whole drag');
  assert.equal(await evaluate('L.D.histState().undo.length') - undo0, 1, 'one highlight is one undo step');
  await key('Escape');

  // a drawn shape's handles go when the user clicks into text, or presses Esc
  const handles = () => evaluate(`({ handles: document.querySelectorAll('.obj-handles').length, outlined: document.querySelectorAll('.sel-obj').length, selected: !!L.ed.objSel })`);
  for (const leave of ['click', 'Escape']) {
    await load();
    await evaluate(`L.ui.exec('drawRect')`);
    const corner = await at(1, 10);
    await drag({ x: corner.x + 300, y: corner.y + 40 }, { x: corner.x + 400, y: corner.y + 120 }, 4);
    assert.deepEqual(await handles(), { handles: 1, outlined: 1, selected: true }, 'the drawn shape is selected');
    if (leave === 'click') await click(await at(1, 5)); else await key('Escape');
    assert.deepEqual(await handles(), { handles: 0, outlined: 0, selected: false }, `no handles after ${leave}`);
    await click({ x: corner.x + 350, y: corner.y + 80 });
    assert.deepEqual(await handles(), { handles: 1, outlined: 1, selected: true }, `a click selects the shape again after ${leave}`);
  }

  assert.deepEqual(page.errors, [], 'browser errors');
  assert.deepEqual(page.requests, [], 'external requests');
  console.log('mouse-selection: ok');
} finally { await page?.close(); stop(); }
