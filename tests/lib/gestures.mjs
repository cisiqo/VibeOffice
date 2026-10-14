// A gesture run through what the reviewers varied to find R1–R4 (todos/UI_MOUSE_LOGIC_IMPROVE.md): the state it
// starts from (the test's own list), what comes in the middle of it (MIDDLE) and how it ends (WAYS_OUT), in each mode
// the app can be in (the test's own list: Track Changes, a header being edited, the speaker notes, frozen panes, …;
// the review of d69ae57 found what broke only there). Each case says whether the gesture should have committed; the
// test checks the rest (what moved, the undo steps).
//
//   for (const c of cases(starts)) await s.test(c.name, async () => { await c.start.run(t); await run(t, from, to, c); … });
import { pause } from './input.mjs';

/** what comes while the button is held: keys wait (only Esc and Ctrl+Z/Y act, ending the drag) */
export const MIDDLE = [
  { name: 'nothing', run: async () => {} },
  { name: 'an arrow key', run: (t) => t.key('ArrowRight') },
  { name: 'a letter', run: (t) => t.key('x') },
  { name: 'Delete', run: (t) => t.key('Delete') },
  { name: 'Ctrl+Z', run: (t) => t.key('z', { ctrl: true }), cancels: true },
];

/** the ways a press ends; p is where the pointer is, q a point to move to afterwards */
export const WAYS_OUT = [
  { name: 'the release', run: (t, p) => t.release(p), commits: true },
  { name: 'Esc, then the release', run: async (t, p) => { await t.esc(); await t.release(p); } },
  { name: 'a right-click, then the release', run: async (t, p) => {
    await t.mouse('mousePressed', p, { button: 'right' }); await pause(60); await t.mouse('mouseReleased', p, { button: 'right' }); await pause(200);
    await t.release(p);
  } },
  { name: 'a release the page never saw', run: async (t, p, q) => { await t.loseRelease(p); await t.move(q); } },
  { name: 'the release in another tab', run: async (t, p, q) => { await t.releaseInOtherTab(); await t.move(q); } },
];

/** each way out after nothing in the middle, and each middle before the release, from each start; brief (a mode the
    app is in, see the tests): each way out, and an arrow key before the release */
export function cases(starts, { brief } = {}) {
  const out = [];
  for (const start of starts) {
    for (const way of WAYS_OUT) out.push({ start, middle: MIDDLE[0], way });
    for (const middle of brief ? MIDDLE.slice(1, 2) : MIDDLE.slice(1)) out.push({ start, middle, way: WAYS_OUT[0] });
  }
  return out.map((c) => Object.assign(c, {
    name: `from ${c.start.name}, ${c.middle.name} in the middle, ending with ${c.way.name}`,
    commits: !c.middle.cancels && !!c.way.commits,
  }));
}

/** press at a, move to b, the middle, the way out (then a move back to a for the ways that need one) */
export async function run(t, a, b, c) {
  await t.press(a);
  await t.glide(a, b, 6);
  await c.middle.run(t);
  await c.way.run(t, b, a);
  await pause(150);
}

/** what must hold after any case, in any app: no drag left, the pointer's own cursor back */
export const settled = (t) => t.evaluate(`({ dragging: L.ui.dragging(),
  cursorHeld: [...document.querySelectorAll('style')].some((s) => /^\\*, \\*::before, \\*::after \\{ cursor:/.test(s.textContent)) })`);
