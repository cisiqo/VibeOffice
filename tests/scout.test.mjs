// Scout, the assistant (public/common/scout/), checked in each app: Help ▸ Show the Assistant brings him in with
// the welcome's choices (introducing himself the first time each day); the right-click menu is the app's own; he
// acts out what the user asks for (Print, Find; saving once the file is written) and works along with a long
// wait, with manners (one act waits for the one under way; a nap ends first); his idling follows the user (small
// things while they work, more once they are quiet, a nap after five minutes that they wake him from); at rest
// nothing is drawn but a blink and now and then the tail's sway, a window in the background draws nothing (he stands
// still), and once hidden the frame loop stops. Then, in Quire: he comes in by himself on a desktop, not on an
// iPhone, in an automated browser (tools/shot.mjs) or on a day the user hid him; and nothing of his own covers his face
// in any action. Leaves the settings as it found them.
//
//   node --test tests/scout.test.mjs   (needs Chromium with CDP at 127.0.0.1:9222, as tools/shot.mjs, or CDP=… for one of
//   its own: the frame checks need the test tab in front; serves on :8775)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
/* on an origin of its own (unless BASE says otherwise): the assistant's settings are shared by an origin's windows,
   so apps open on :8760 would answer this test's changes to them (the storage event) and change them back */
const env = { ...process.env, BASE: process.env.BASE || 'http://127.0.0.1:8775' };

const CHECK = `
const KEYS = ['vibeoffice.assistant', 'scout.lastGreetedDay', 'scout.lastHiddenDay'], KEY = KEYS[0];
const kept = JSON.parse(sessionStorage.getItem('scout.test.kept'));   // by tests/scout/clean.js
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ui = L.ui, out = {};
const until = async (f, ms) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(30); return f(); };
try {
  for (const k of KEYS) localStorage.removeItem(k);
  out.auto = L.assistant.shown();
  const help = L.app.menuBar.menus.find((m) => m.label === '&Help');
  out.inHelp = !!help && help.items.includes('showAssistant');
  out.labelOff = ui.cmds.showAssistant.label;
  ui.exec('showAssistant');
  out.firstAct = L.assistant.scout().current && L.assistant.scout().current.name;
  await sleep(4000);
  const s = L.assistant.scout();
  out.labelOn = ui.cmds.showAssistant.label;
  out.stored = JSON.parse(localStorage.getItem(KEY)).on;
  out.visible = !s.hidden && getComputedStyle(s.el).visibility !== 'hidden';
  out.said = document.querySelector('.scout-balloon.is-on .scout-text').textContent;
  out.welcome = [...document.querySelectorAll('.scout-balloon.is-on .scout-choices button')].map((b) => b.textContent);
  /* the right-click menu */
  const r = s.svg.getBoundingClientRect();
  s.svg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
  out.menu = [...document.querySelectorAll('.menu .m-lbl')].map((x) => x.textContent);
  out.seps = document.querySelectorAll('.menu .m-sep').length;
  out.lastIsHide = document.querySelector('.menu').lastElementChild.previousElementSibling.classList.contains('m-sep');
  ui.closeMenus();
  /* shown again the same day: a wave, nothing said */
  s.stop();
  L.assistant.show(true);
  out.againAct = s.current && s.current.name;
  await sleep(2500);
  out.saidAgain = document.querySelector('.scout-balloon.is-on') ? document.querySelector('.scout-balloon.is-on .scout-text').textContent : null;
  /* a click on him: the choices */
  s.o.onclick();
  await sleep(1500);
  out.onClick = document.querySelector('.scout-balloon.is-on .scout-text') && document.querySelector('.scout-balloon.is-on .scout-text').textContent;
  out.choices = [...document.querySelectorAll('.scout-balloon.is-on .scout-choices button')].map((b) => b.textContent);
  s.stop();
  /* acting out what the user does, from the suite's signals */
  const act = async (fn) => { s.stop(); await sleep(250); fn(); await sleep(150); return s.current && s.current.name; };
  const command = (id) => window.dispatchEvent(new CustomEvent('vo-command', { detail: { id } }));
  /* Save and Save As once the file is written (L.saveFile, its download link held back here) */
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {};
  const written = () => L.saveFile('scout-test.txt', new Blob(['x']));
  try {
    out.onPrint = await act(() => command('print'));
    out.printWritten = await act(written);
    out.onExport = await act(() => command('exportPDF'));
    out.onSaveAs = await act(() => command('saveAs'));
    out.onSave = await act(written);
  } finally { HTMLAnchorElement.prototype.click = click; }
  out.onWork = await act(() => ui.busy(true, 'Opening...'));
  await sleep(400);
  out.working = s.current && s.current.name;
  ui.busy(false);
  out.onFind = await act(() => command('find'));
  out.findAgain = await act(() => command('find'));
  let told = null;
  const listen = (e) => { told = e.detail.id; };
  addEventListener('vo-command', listen);
  ui.exec('selectAll');
  removeEventListener('vo-command', listen);
  out.told = told;
  s.stop();
  s.ask('Shall I?', ['Yes']);
  await sleep(300);
  command('insertPicture');
  await sleep(150);
  out.whileAsking = s.current && s.current.name;
  s.stop();
  let n = 0;
  const tick = s._tick.bind(s);
  s._tick = (dt) => { n++; tick(dt); };
  const count = async (ms) => { n = 0; await sleep(ms); return n; };
  const now = () => s.current && s.current.name + (s.current.loop ? ' loop' : '');
  /* one act waits for the one under way, a newer one in its place; the act he is at already, nothing new */
  await sleep(250);
  command('print');
  await sleep(150);
  command('print'); command('find'); command('insertPicture');
  out.waitWhile = now();
  out.waiting = s._nx && s._nx.name;
  await until(() => now() !== 'Print', 6000);
  out.waitedFor = now();
  s.stop();
  /* after an act, idling starts over: quiet for a minute (an idle every 8-16 s), nothing straight after it */
  s._activeAt = s._clock - 60; s._restAt = s._clock - 60;
  command('find');
  await until(() => !s.current, 6000);
  await sleep(600);
  out.afterAct = now();
  /* idling follows the user: while they work, a small thing 45-90 s after his last act; quiet for 30 s, every
     8-16 s; quiet for five minutes, a nap */
  /* (at rest he looks at the time once a second; _tick(0) has him look now) */
  const idleAfter = async (quiet, rest) => { s.stop(); await sleep(20); s._activeAt = s._clock - quiet; s._restAt = s._clock - rest; s._tick(0); await sleep(100); return s.current && s.current.idle ? now() : null; };
  out.busyEarly = await idleAfter(0, 44);
  out.busy = [];
  for (let i = 0; i < 6; i++) out.busy.push(await idleAfter(0, 91));
  out.quietEarly = await idleAfter(31, 7.5);
  out.quiet = await idleAfter(31, 17);
  out.napEarly = await idleAfter(299, 9.5);
  out.nap = await idleAfter(301, 2.1);
  /* asleep: about 10 frames a second; the mouse moving doesn't wake him, a key does */
  await sleep(2000);
  out.napping = now();
  out.napFrames = await count(1000);
  window.dispatchEvent(new PointerEvent('pointermove'));
  out.moved = now();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
  out.wakes = now();
  await until(() => !s.current, 3000);
  out.awake = now();
  /* asleep, the user saves: he wakes up, then saves */
  await idleAfter(301, 2.1);
  await sleep(2000);
  command('save');
  window.dispatchEvent(new CustomEvent('vo-saved', { detail: { name: 'scout-test.txt' } }));
  out.saveWakes = now();
  await until(() => now() !== 'IdleSnooze', 3000);
  out.thenSaves = now();
  s.stop();
  /* frames drawn: at rest none (a look at the time each second), but a blink (every frame) and the tail's sway now
     and then (about 10 a second); acting, every frame; in the background none; once hidden none */
  let drawn = 0;
  const render = s._render.bind(s);
  s._render = (...a) => { drawn++; render(...a); };
  const draws = async (ms) => { drawn = 0; await sleep(ms); return drawn; };
  s.o.idle = false;
  s._nextBlink = s._nextSway = 1e9;
  /* the tail into and out of an action: no jumps (its wag keeps its own phase while the pace changes) */
  const tailSteps = async (name) => {
    const angles = [];
    s._render = (p, time) => { angles.push(p.tail + p.wag * Math.sin(p.wagPh != null ? p.wagPh : Math.PI * 2 * p.wagHz * time)); render(p, time); };
    s._clock += 300;   // five minutes on screen
    await sleep(200); await s.play(name); await sleep(400);
    s._render = (...a) => { drawn++; render(...a); };
    return Math.max(...angles.slice(1).map((a, i) => Math.abs(a - angles[i])));
  };
  out.tailGlance = await tailSteps('LookLeft');
  out.tailBlink = await tailSteps('IdleSlowBlink');
  await sleep(500);
  out.rest = await draws(2000);
  out.restTicks = await count(2000);
  s._nextSway = s._clock; s._kick();
  await sleep(100);
  out.sway = await draws(2000);
  await sleep(1500);
  s._nextSway = 1e9;
  s._nextBlink = s._clock; s._kick();
  out.blink = await draws(400);
  s._nextBlink = 1e9;
  s.play('Wave');
  out.acting = await count(1000);
  s.o.idle = true;
  const hasFocus = document.hasFocus;
  document.hasFocus = () => false;
  window.dispatchEvent(new Event('blur'));
  await sleep(400);
  out.background = await count(1000);
  document.hasFocus = hasFocus;
  window.dispatchEvent(new Event('focus'));
  out.back = await count(1000);
  ui.exec('showAssistant');
  await sleep(150);
  out.goodbye = s.current && s.current.name;
  await sleep(3700);
  out.hidden = s.hidden;
  out.afterHide = await count(1000);
  out.storedOff = JSON.parse(localStorage.getItem(KEY)).on;
  out.hiddenDay = localStorage.getItem('scout.lastHiddenDay');
  out.today = new Date().toLocaleDateString('sv');
} finally {
  KEYS.forEach((k, i) => { if (kept[i] == null) localStorage.removeItem(k); else localStorage.setItem(k, kept[i]); });
  sessionStorage.removeItem('scout.test.kept');
}
return JSON.stringify(out);
`;

for (const app of ['quire', 'ledger', 'lectern']) {
  test(`${app}: Scout welcomes, has his menu, and draws nothing in the background or hidden`, () => {
    const out = execFileSync('node', [path.join(root, 'tools/shot.mjs'), app + '/', JSON.stringify([{ js: CHECK, wait: 200 }]), '--pre', path.join(root, 'tests/scout/clean.js')], { encoding: 'utf8', env });
    const line = out.split('\n').find((l) => l.startsWith('js -> '));
    assert.ok(line, out);
    const r = JSON.parse(JSON.parse(line.slice(6)));
    assert.equal(r.auto, false, 'not by himself in an automated browser');
    assert.ok(r.inHelp, 'Show the Assistant is in the Help menu');
    assert.equal(r.labelOff, 'Show the &Assistant');
    assert.equal(r.labelOn, 'Hide the &Assistant');
    assert.equal(r.firstAct, 'Greeting', 'shown from the menu, he waves');
    assert.equal(r.stored, true, 'shown is kept for the suite');
    assert.ok(r.visible, 'he is on the window');
    assert.match(r.said, /^Good (morning|afternoon|evening)! I'm Scout, your soon-to-be-AI assistant\. For now, I mostly fetch\. What would you like to do\?$/, 'the first time today');
    assert.deepEqual(r.welcome, r.choices, 'with the same choices as a click');
    assert.equal(r.againAct, 'Greeting', 'shown again the same day: he waves');
    assert.equal(r.saidAgain, null, 'and says nothing');
    assert.equal(r.onClick, 'What would you like to do?', 'a click on him asks');
    assert.equal(r.choices[0], 'Find a command by name');
    assert.ok(r.choices.includes('Look something up in Help') && r.choices.at(-1) === 'Nothing for now', r.choices.join(', '));
    assert.deepEqual(r.menu.slice(0, 2), ['Animate!', 'Search commands']);
    assert.match(r.menu[2], /Help$/);
    assert.equal(r.menu.at(-1), 'Hide');
    assert.equal(r.seps, 2, 'separators: after Animate!, before Hide');
    assert.ok(r.lastIsHide, 'a separator just before Hide');
    assert.equal(r.onPrint, 'Print', 'Print');
    assert.equal(r.printWritten, null, 'a PDF written after Print is no save');
    assert.equal(r.onExport, null, 'an export: nothing when asked');
    assert.equal(r.onSaveAs, null, 'Save As: nothing while its dialog opens');
    assert.equal(r.onSave, 'Save', 'Save As: once the file is written');
    assert.equal(r.onWork, null, 'nothing for a short wait');
    assert.equal(r.working, 'Processing', 'working along once the wait goes on');
    assert.equal(r.onFind, 'Searching', 'Find');
    assert.equal(r.findAgain, 'Searching', 'the same act again: no wait');
    assert.equal(r.told, 'selectAll', 'ui.exec tells vo-command');
    assert.equal(r.whileAsking, null, 'nothing while he asks something');
    assert.equal(r.waitWhile, 'Print', 'the act under way plays out');
    assert.equal(r.waiting, 'GetArtsy', 'one act waits, the newest');
    assert.equal(r.waitedFor, 'GetArtsy', 'and plays next');
    assert.equal(r.afterAct, null, 'no idle straight after an act');
    assert.equal(r.busyEarly, null, 'while the user works: nothing within 45 s of his last act');
    const small = ['Idle1_1', 'IdleEarFlick', 'IdleSlowBlink', 'IdleWatchWork', 'IdleTailThump', 'IdleSettle', 'IdleCurious', 'IdleLookAtYou', 'IdleLickChops',
      'IdleEyeBrowRaise', 'LookLeft', 'LookDownLeft', 'LookRight', 'LookDownRight', 'LookUpLeft', 'LookDown', 'LookUpRight', 'LookUp'];
    r.busy.forEach((b, i) => {
      assert.ok(small.includes(b), `while the user works: a small thing, not ${b}`);
      assert.ok(b !== r.busy[i - 1] && b !== r.busy[i - 2], `not one of his last two idles: ${r.busy.join(', ')}`);
    });
    assert.equal(r.quietEarly, null, 'quiet: nothing within 8 s of his last act');
    assert.ok(r.quiet && r.quiet !== 'IdleSnooze', `quiet for 30 s: an idle (${r.quiet})`);
    assert.notEqual(r.napEarly, 'IdleSnooze', 'no nap before five minutes');
    assert.equal(r.nap, 'IdleSnooze loop', 'quiet for five minutes: a nap');
    assert.equal(r.napping, 'IdleSnooze loop', 'he sleeps on');
    assert.equal(r.moved, 'IdleSnooze loop', 'the mouse moving: he sleeps on');
    assert.equal(r.wakes, 'IdleSnooze', 'a key wakes him');
    assert.equal(r.awake, null, 'awake, nothing else');
    assert.equal(r.saveWakes, 'IdleSnooze', 'asleep, a save wakes him');
    assert.equal(r.thenSaves, 'Save', 'then he saves');
    assert.ok(r.tailGlance < 1 && r.tailBlink < 1, `the tail into and out of an action, the most it moves in a frame: ${r.tailGlance}°, ${r.tailBlink}°`);
    assert.equal(r.rest, 0, 'at rest nothing is drawn');
    assert.ok(r.restTicks <= 4, `at rest a look at the time each second: ${r.restTicks} in 2 s`);
    assert.ok(r.sway >= 10 && r.sway <= 30, `the tail's sway, about 10 frames a second: ${r.sway} in 2 s`);
    assert.ok(r.blink >= 6, `a blink has every frame: ${r.blink}`);
    assert.ok(r.napFrames >= 4 && r.napFrames <= 15, `asleep, about 10 frames a second: ${r.napFrames}`);
    assert.ok(r.acting >= 30, `acting, every frame: ${r.acting} a second`);
    assert.equal(r.background, 0, 'frames while the window is in the background');
    assert.ok(r.back >= 8, `frames once back: ${r.back}`);
    assert.equal(r.goodbye, 'GoodBye', 'he waves goodbye');
    assert.ok(r.hidden, 'Hide the Assistant hides him');
    assert.equal(r.afterHide, 0, 'frames once hidden');
    assert.equal(r.storedOff, false, 'hidden is kept for the suite');
    assert.equal(r.hiddenDay, r.today, 'and the day he was hidden');
    assert.match(out, /no errors, no external requests/);
  });
}

/* his face, in every action but coming and going, every 0.1 s: his ears, the head's outline and his
   body never cover his eyes, nose, muzzle or tongue (hit-tested at points in each part's own drawing); a paw or a prop
   in front of his face may, and a wet-dog shake flings his ears across it */
const FACE = `
const host = document.createElement('div');
host.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff;padding:20px';
document.body.appendChild(host);
const s = new L.Scout({ mode: 'still', parent: host, size: 400 });
const bad = {};
let checks = 0;
const inside = (el, name) => !!el && !!el.closest('[data-p="' + name + '"]');
const by = (el) => { const g = el && el.closest('[data-p]'); return g ? g.getAttribute('data-p') : el ? el.tagName : 'nothing'; };
const centre = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
for (const n of L.Scout.all) {
  const info = L.Scout.info(n);
  if (info.cat === 'entrance') continue;
  for (let i = 0; i * .1 <= info.dur + 1e-9; i++) {
    const t = i * .1;
    s.pose(n, t);
    const p = s._last, P = s.P, want = [];
    /* points in the part's own drawing, so they turn and tilt with it */
    const at = (el, x, y) => { const m = el.getScreenCTM(), q = new DOMPoint(x, y).matrixTransform(m); return [q.x, q.y]; };
    if (p.happy < .3) for (const S of ['L', 'R']) if (Math.max(p['lid' + S], p['low' + S]) < .5) {
      const cx = S === 'L' ? 88 : 112;
      for (const dx of [-4.5, 0, 4.5]) want.push(['eye' + S, at(P['rim' + S], cx + dx, 66)]);
    }
    want.push(['nose', at(P.nose, 100, 80)]);
    if (p.tongue > .3) { const b = P.tongueP.getBBox(), cx = b.x + b.width / 2; for (const k of [.5, .75]) want.push(['tongueOut', at(P.tongueP, cx, b.y + b.height * k)]); want.push(['tongueOut', at(P.tongueP, cx, b.y + b.height - 1.5)]); }
    for (const [x, y] of [[100, 100.5], [84, 96], [116, 96]]) want.push(['face', at(P.muzzle, x, y)]);
    want.push(['face', at(P.blaze, 100, 42)]);
    for (const [name, [x, y]] of want) {
      checks++;
      const hit = document.elementFromPoint(x, y);
      if (inside(hit, name)) continue;
      const who = by(hit);
      if (!/^(ear[LR]|head|body|root|nothing|DIV|svg)$/.test(who)) continue;   // a paw or a prop in front of his face: by design
      if (n === 'Shake' && /^ear/.test(who)) continue;   // a wet-dog shake flings his ears across his face
      const k = n + ': ' + name + ' under ' + who;
      (bad[k] = bad[k] || []).push(+t.toFixed(1));
    }
  }
}
s.destroy(); host.remove();
return JSON.stringify({ checks, bad: Object.entries(bad).map(([k, ts]) => k + ' (' + ts.length + ' poses, ' + ts[0] + '-' + ts[ts.length - 1] + ' s)') });
`;
test('Scout: nothing of his own covers his eyes, nose, muzzle or tongue (every action)', () => {
  const out = execFileSync('node', [path.join(root, 'tools/shot.mjs'), 'quire/', JSON.stringify([{ js: FACE, wait: 100 }]), '--timeout', '280000'], { encoding: 'utf8', env, timeout: 300000 });
  const line = out.split('\n').find((l) => l.startsWith('js -> '));
  assert.ok(line, out);
  const r = JSON.parse(JSON.parse(line.slice(6)));
  assert.ok(r.checks > 15000, `points checked: ${r.checks}`);
  assert.deepEqual(r.bad, [], r.bad.join('\n'));
});

/* comes in by himself in a person's desktop browser; not on iOS or Android, nor on a day the user hid him
   (tools/shot.mjs is automated, so scripts before the page's own make it a person's browser and set the day) */
const UNASKED = `
const first = L.assistant.scout() && L.assistant.scout().current;
await new Promise((r) => setTimeout(r, 4500));
const s = L.assistant.scout(), said = document.querySelector('.scout-balloon.is-on .scout-text');
const out = { mobile: L.isMobile, webdriver: navigator.webdriver, shown: L.assistant.shown(), visible: !!s && !s.hidden, first: first && first.name,
  said: said ? said.textContent : null, choices: document.querySelectorAll('.scout-balloon.is-on .scout-choices button').length };
L.assistant.hide(true);
const kept = JSON.parse(sessionStorage.getItem('scout.test.kept'));
['vibeoffice.assistant', 'scout.lastGreetedDay', 'scout.lastHiddenDay'].forEach((k, i) => { if (kept[i] == null) localStorage.removeItem(k); else localStorage.setItem(k, kept[i]); });
sessionStorage.removeItem('scout.test.kept');
return JSON.stringify(out);
`;
/* [case, scripts before the page's, comes in, mobile, first act] */
for (const [name, pre, want, mobile, first] of [
  ['a desktop', ['clean', 'unasked'], true, false, 'Greeting'],
  ['a desktop, greeted today already', ['clean', 'unasked', 'greeted-today'], true, false, 'Show'],
  ['an iPhone', ['clean', 'unasked', 'iphone'], false, true],
  ['a desktop where he was hidden today', ['clean', 'unasked', 'hidden-today'], false, false],
  ['a desktop where he was hidden another day', ['clean', 'unasked', 'hidden-before'], true, false, 'Greeting'],
]) {
  test(`Scout comes in by himself on ${name}: ${want}${first ? ', with ' + first : ''}`, () => {
    const files = pre.map((f) => path.join(root, 'tests/scout', f + '.js')).join(',');
    const out = execFileSync('node', [path.join(root, 'tools/shot.mjs'), 'quire/', JSON.stringify([{ js: UNASKED, wait: 100 }]), '--pre', files], { encoding: 'utf8', env });
    const line = out.split('\n').find((l) => l.startsWith('js -> '));
    assert.ok(line, out);
    const r = JSON.parse(JSON.parse(line.slice(6)));
    assert.equal(r.webdriver, false);
    assert.equal(r.mobile, mobile);
    assert.equal(r.shown, want);
    assert.equal(r.visible, want);
    if (first) assert.equal(r.first, first, 'his first act');
    if (first === 'Greeting') {
      assert.match(r.said, /^Good (morning|afternoon|evening)! I'm Scout, your soon-to-be-AI assistant\. For now, I mostly fetch\. What would you like to do\?$/);
      assert.ok(r.choices > 3, 'with the choices');
    } else assert.equal(r.said, null, 'nothing said');
    assert.match(out, /no errors, no external requests/);
  });
}
