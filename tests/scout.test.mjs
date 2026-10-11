// Scout, the assistant (public/common/scout/), checked in each app: Help ▸ Show the Assistant brings him in with
// the welcome's choices (introducing himself the first time each day); the right-click menu is the app's own; he
// acts out what the user asks for (Print, Find; saving once the file is written) and works along with a long
// wait, with manners; a window in the background draws nothing (he stands
// still), and once hidden the frame loop stops. Then, in Quire: he comes in by himself on a desktop, not on an
// iPhone, in an automated browser (tools/shot.mjs) or on a day the user hid him. Leaves the settings as it found them.
//
//   node --test tests/scout.test.mjs   (needs Chromium with CDP at 127.0.0.1:9222, as tools/shot.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const CHECK = `
const KEYS = ['vibeoffice.assistant', 'scout.lastGreetedDay', 'scout.lastHiddenDay'], KEY = KEYS[0];
const kept = KEYS.map((k) => localStorage.getItem(k));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ui = L.ui, out = {};
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
  /* frames drawn: in front, in the background, back again, hidden */
  let n = 0;
  const tick = s._tick.bind(s);
  s._tick = (dt) => { n++; tick(dt); };
  const count = async (ms) => { n = 0; await sleep(ms); return n; };
  out.front = await count(500);
  const hasFocus = document.hasFocus;
  document.hasFocus = () => false;
  window.dispatchEvent(new Event('blur'));
  await sleep(400);
  out.background = await count(1000);
  document.hasFocus = hasFocus;
  window.dispatchEvent(new Event('focus'));
  out.back = await count(500);
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
}
return JSON.stringify(out);
`;

for (const app of ['quire', 'ledger', 'lectern']) {
  test(`${app}: Scout welcomes, has his menu, and draws nothing in the background or hidden`, () => {
    const out = execFileSync('node', [path.join(root, 'tools/shot.mjs'), app + '/', JSON.stringify([{ js: CHECK, wait: 200 }])], { encoding: 'utf8' });
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
    assert.equal(r.findAgain, null, 'the same act again within 20 s');
    assert.equal(r.told, 'selectAll', 'ui.exec tells vo-command');
    assert.equal(r.whileAsking, null, 'nothing while he asks something');
    assert.ok(r.front > 10, `frames in front: ${r.front}`);
    assert.equal(r.background, 0, 'frames while the window is in the background');
    assert.ok(r.back > 10, `frames once back: ${r.back}`);
    assert.equal(r.goodbye, 'GoodBye', 'he waves goodbye');
    assert.ok(r.hidden, 'Hide the Assistant hides him');
    assert.equal(r.afterHide, 0, 'frames once hidden');
    assert.equal(r.storedOff, false, 'hidden is kept for the suite');
    assert.equal(r.hiddenDay, r.today, 'and the day he was hidden');
    assert.match(out, /no errors, no external requests/);
  });
}

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
  ['a desktop', ['unasked'], true, false, 'Greeting'],
  ['a desktop, greeted today already', ['unasked', 'greeted-today'], true, false, 'Show'],
  ['an iPhone', ['unasked', 'iphone'], false, true],
  ['a desktop where he was hidden today', ['unasked', 'hidden-today'], false, false],
  ['a desktop where he was hidden another day', ['unasked', 'hidden-before'], true, false, 'Greeting'],
]) {
  test(`Scout comes in by himself on ${name}: ${want}${first ? ', with ' + first : ''}`, () => {
    const files = pre.map((f) => path.join(root, 'tests/scout', f + '.js')).join(',');
    const out = execFileSync('node', [path.join(root, 'tools/shot.mjs'), 'quire/', JSON.stringify([{ js: UNASKED, wait: 100 }]), '--pre', files], { encoding: 'utf8' });
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
