// ui.drag (common/ui.js), the one drag lifecycle of the three apps, with real input on a pad in each app's page: a
// click or a wobble under the threshold moves nothing; the release ends a drag; Esc, a second button, a release the
// page never saw, the window losing focus and ui.dragCancel() cancel it, and the key, the button and its context menu
// go no further (todos/UI_MOUSE_LOGIC_IMPROVE.md, Phase 2).
//
//   node --test --test-concurrency=1 tests/ui/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, pause } from '../lib/input.mjs';

/** a pad on top of the app that starts a ui.drag; what happens is in __drag: move, up:<moved>, cancel, and what got
    past it to the page: esc, rdown, menu */
const PAD = `(() => {
  const pad = document.createElement('div');
  pad.id = 'drag-pad';
  pad.style.cssText = 'position:fixed;left:200px;top:200px;width:400px;height:300px;z-index:99999;background:#cde';
  document.body.appendChild(pad);
  window.__drag = [];
  pad.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    L.ui.drag(e, { move: () => { if (__drag[__drag.length - 1] !== 'move') __drag.push('move'); }, up: (ev, d) => __drag.push('up:' + d.moved), cancel: (d, why) => __drag.push('cancel:' + why) });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') __drag.push('esc'); });
  document.addEventListener('mousedown', (e) => { if (e.button === 2) __drag.push('rdown'); });
  document.addEventListener('contextmenu', (e) => { __drag.push('menu'); e.preventDefault(); });
})()`;

for (const app of ['quire', 'ledger', 'lectern']) {
  let t;
  const A = { x: 300, y: 300 }, B = { x: 420, y: 380 };
  /** a gesture on a fresh log; what the log says after it (and after the button is let go, when it is still down) */
  const gesture = async (fn) => {
    await t.evaluate('window.__drag = []; L.ui.dragCancel()');
    await fn();
    await pause(100);
    return t.evaluate('__drag.slice()');
  };
  test(`${app}: ui.drag`, async (s) => {
    t = await open(app);
    await t.evaluate(PAD);
    try {
      await s.test('a click runs up, not move', async () => {
        assert.deepEqual(await gesture(() => t.click(A)), ['up:false']);
      });
      await s.test('a wobble under the threshold runs no move', async () => {
        assert.deepEqual(await gesture(async () => { await t.press(A); await t.glide(A, { x: A.x + 2, y: A.y + 2 }, 2); await t.release({ x: A.x + 2, y: A.y + 2 }); }), ['up:false']);
      });
      await s.test('a drag runs move, then up', async () => {
        assert.deepEqual(await gesture(() => t.drag(A, B)), ['move', 'up:true']);
      });
      await s.test('Esc cancels it, and goes no further', async () => {
        assert.deepEqual(await gesture(async () => { await t.press(A); await t.glide(A, B); await t.esc(); await t.release(B); }), ['move', 'cancel:esc']);
      });
      await s.test('a second button cancels it; its press and its menu go no further', async () => {
        assert.deepEqual(await gesture(async () => {
          await t.press(A); await t.glide(A, B);
          await t.mouse('mousePressed', B, { button: 'right' }); await pause(60); await t.mouse('mouseReleased', B, { button: 'right' }); await pause(200);
          await t.release(B);
        }), ['move', 'cancel:button']);
      });
      await s.test('a release the page never saw cancels it at the next move', async () => {
        assert.deepEqual(await gesture(async () => { await t.press(A); await t.glide(A, B); await t.loseRelease(B); await t.move(A); }), ['move', 'cancel:lost']);
      });
      await s.test('the button let go in another tab cancels it', async () => {
        assert.deepEqual(await gesture(async () => { await t.press(A); await t.glide(A, B); await t.releaseInOtherTab(); await t.move(A); }), ['move', 'cancel:blur']);
      });
      await s.test('ui.dragCancel() cancels it (a tool or view switch)', async () => {
        assert.deepEqual(await gesture(async () => { await t.press(A); await t.glide(A, B); await t.evaluate('L.ui.dragCancel()'); await t.release(B); }), ['move', 'cancel:api']);
      });
      await s.test('Ctrl+Z cancels it (the drag is what gets undone), and goes no further', async () => {
        await t.evaluate(`document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'z') __drag.push('ctrl-z'); })`);
        assert.deepEqual(await gesture(async () => { await t.press(A); await t.glide(A, B); await t.key('z', { ctrl: true }); await t.release(B); }), ['move', 'cancel:undo']);
      });
      await s.test('other keys wait while the button is held: an arrow key goes no further, the drag goes on', async () => {
        await t.evaluate(`document.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') __drag.push('arrow'); })`);
        assert.deepEqual(await gesture(async () => { await t.press(A); await t.glide(A, B); await t.key('ArrowRight'); await t.glide(B, A, 3); await t.release(A); }), ['move', 'up:true']);
      });
      await s.test('after a middle-button cancel, a right-click opens its menu at once', async () => {
        assert.deepEqual(await gesture(async () => {
          await t.press(A); await t.glide(A, B);
          await t.mouse('mousePressed', B, { button: 'middle' }); await pause(60); await t.mouse('mouseReleased', B, { button: 'middle' }); await pause(100);
          await t.release(B); await pause(100);
          await t.rightClick(A);
        }), ['move', 'cancel:button', 'rdown', 'menu']);
      });
      await s.test('the cursor of the press stays while the pointer moves, over anything', async () => {
        await t.evaluate(`document.getElementById('drag-pad').style.cursor = 'col-resize'`);
        await t.press(A); await t.glide(A, { x: 900, y: 650 }, 6);
        const during = await t.evaluate(`getComputedStyle(document.elementFromPoint(900, 650)).cursor`);
        await t.release({ x: 900, y: 650 });
        const after = await t.evaluate(`getComputedStyle(document.elementFromPoint(900, 650)).cursor`);
        await t.evaluate(`document.getElementById('drag-pad').style.cursor = ''`);
        assert.equal(during, 'col-resize');
        assert.notEqual(after, 'col-resize');
      });
      await s.test('the pad drawn again in the middle of the drag: the drag goes on', async () => {
        assert.deepEqual(await gesture(async () => {
          await t.press(A); await t.glide(A, B, 4);
          await t.evaluate(`(() => { const p = document.getElementById('drag-pad'), q = p.cloneNode(); p.replaceWith(q); })()`);
          await t.glide(B, A, 4); await t.release(A);
        }), ['move', 'up:true']);
      });
      await s.test('a press of another button starts no drag', async () => {
        assert.equal(await t.evaluate(`L.ui.drag({ button: 2, clientX: 0, clientY: 0, target: document.body }, {})`), null);
        assert.equal(await t.evaluate('L.ui.dragging()'), false);
      });
      await s.test('no browser errors, no external requests', () => t.clean());
    } finally { await t.close(); }
  });
}
