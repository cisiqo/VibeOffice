// Real mouse and keyboard input for the UI tests (tests/ui/), in the local Chromium over CDP (127.0.0.1:9222):
// CDP Input events paced like a hand, never synthetic DOM events, which hide what an app does in the middle of a
// drag. Starts the static server (tools/serve.py), and a headless Chromium (profile tmp/chromium-profile) when
// nothing listens on CDP; that Chromium stays for the next run. CDP=http://127.0.0.1:9223 runs on a Chromium of its
// own (profile tmp/chromium-profile-9223), so two runs at once don't take each other's focus.
//
//   const t = await open('quire');            // a new tab on the app, 1280×800, the assistant waiting to be asked
//   await t.drag(a, b); await t.key('b', { ctrl: true }); assert.equal(await t.painting(), false);
//   t.clean(); await t.close();
//
// Points are client pixels { x, y }. Modifiers: { shift, ctrl, alt, meta }.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { ensureServer, openPage } from '../../tools/ooxml/cdp.mjs';

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CDP = process.env.CDP || 'http://127.0.0.1:9222';

/** a Chromium listening on CDP: the one running, or a headless one started here */
export async function ensureChromium() {
  const up = () => fetch(CDP + '/json/version').then((r) => r.ok, () => false);
  if (await up()) return;
  const bin = process.env.CHROMIUM || ['chromium', 'chromium-browser', 'google-chrome'].find((b) => {
    try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; }
  });
  if (!bin) throw new Error(`No Chromium on CDP ${CDP} and none found to start (set CHROMIUM)`);
  const port = new URL(CDP).port, profile = path.join(root, 'tmp', port === '9222' ? 'chromium-profile' : 'chromium-profile-' + port);
  fs.mkdirSync(profile, { recursive: true });
  spawn(bin, ['--headless=new', '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--no-first-run',
    '--user-data-dir=' + profile, 'about:blank'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 100; i++) { if (await up()) return; await pause(100); }
  throw new Error(`Started ${bin}, but nothing answers on ${CDP}`);
}

const BIT = { left: 1, right: 2, middle: 4 };
const mods = (o = {}) => (o.alt ? 1 : 0) | (o.ctrl ? 2 : 0) | (o.meta ? 4 : 0) | (o.shift ? 8 : 0);
const KEYS = {
  Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Insert: ['Insert', 45],
  F2: ['F2', 113], F3: ['F3', 114], F4: ['F4', 115], F5: ['F5', 116], F9: ['F9', 120], F10: ['F10', 121],
  Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18], ' ': ['Space', 32, ' '],
};
const PUNCT = { '(': 57, ')': 48, '=': 187, '+': 187, ',': 188, ':': 186, ';': 186, '.': 190, '-': 189, '*': 56, '/': 191,
  '$': 52, '!': 49, '"': 222, "'": 222, '?': 191, '%': 53, '&': 55, '<': 188, '>': 190 };
/** [code, keyCode, text] of a key name or a printable character */
function keyInfo(k) {
  if (KEYS[k]) return KEYS[k];
  if (/^[a-z]$/i.test(k)) return ['Key' + k.toUpperCase(), k.toUpperCase().charCodeAt(0), k];
  if (/^[0-9]$/.test(k)) return ['Digit' + k, k.charCodeAt(0), k];
  if (k.length === 1) return ['', PUNCT[k] || 0, k];
  throw new Error('Unknown key ' + k);
}

/** a new tab on app ('quire', 'ledger', 'lectern') with real input; opts: { width, height, look ('classic',
    'paper', 'paper2016') } */
export async function open(app, opts = {}) {
  await ensureChromium();
  const stopServer = await ensureServer();
  // once more if the page didn't come up in time (seen while other sessions share the browser)
  const page = await openPage(app, { persistence: false, automated: true }).catch((e) => {
    if (!/did not attach/.test(e.message)) throw e;
    return openPage(app, { persistence: false, automated: true });
  });
  const { send, evaluate } = page;
  await send('Emulation.setDeviceMetricsOverride', { width: opts.width || 1280, height: opts.height || 800, deviceScaleFactor: 1, mobile: false });
  // the tab behaves as focused while other windows or tabs are in front (blurWindow turns this off for a while)
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // a look for this test (it is saved for the profile, so close() puts the one before back)
  const lookBefore = opts.look && await evaluate('VO.look.get()');
  if (opts.look) await evaluate(`VO.look.set(${JSON.stringify(opts.look)})`);
  await pause(400);

  let buttons = 0;
  const t = {
    ...page,
    app,
    async close() {
      if (lookBefore && lookBefore !== opts.look) await evaluate(`VO.look.set(${JSON.stringify(lookBefore)})`).catch(() => {});
      await page.close(); stopServer();
    },
    /** one mouse event; o: { button, clickCount, buttons (what the event says is held), shift, ctrl, alt, meta } */
    mouse(type, { x, y }, o = {}) {
      const button = o.button || 'left';
      if (type === 'mousePressed') buttons |= BIT[button];
      if (type === 'mouseReleased') buttons &= ~BIT[button];
      const held = o.buttons ?? buttons;
      return send('Input.dispatchMouseEvent', { type, x, y, modifiers: mods(o), buttons: held,
        button: type === 'mouseMoved' ? (held & 1 ? 'left' : held & 2 ? 'right' : held & 4 ? 'middle' : 'none') : button,
        clickCount: o.clickCount ?? (type === 'mouseMoved' ? 0 : 1) });
    },
    async move(p, o) { await t.mouse('mouseMoved', p, o); await pause(45); },
    async press(p, o) { await t.move(p, o); await t.mouse('mousePressed', p, o); await pause(60); },
    async release(p, o) { await t.mouse('mouseReleased', p, o); await pause(300); },
    /** move from a to b in steps, with whatever buttons are held */
    async glide(a, b, steps = 8, o) {
      for (let i = 1; i <= steps; i++) { await t.mouse('mouseMoved', { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps }, o); await pause(45); }
    },
    async drag(a, b, steps = 8, o) { await t.press(a, o); await t.glide(a, b, steps, o); await t.release(b, o); },
    async click(p, o = {}) { await t.move(p, o); await t.mouse('mousePressed', p, o); await pause(50); await t.mouse('mouseReleased', p, o); await pause(300); },
    /** n clicks in a row (2: double-click, 3: triple-click) */
    async clicks(p, n, o = {}) {
      await t.move(p, o);
      for (let c = 1; c <= n; c++) {
        await t.mouse('mousePressed', p, { ...o, clickCount: c }); await pause(40);
        await t.mouse('mouseReleased', p, { ...o, clickCount: c }); await pause(c < n ? 80 : 300);
      }
    },
    dblclick: (p, o) => t.clicks(p, 2, o),
    rightClick: (p, o = {}) => t.click(p, { ...o, button: 'right' }),
    /** the held buttons go up where the page can't see it: moves after this report no button held */
    async loseRelease(p) { buttons = 0; await t.mouse('mouseMoved', p); await pause(45); },
    /** a key by name ('Enter', 'ArrowDown', 'F2') or a character; o: modifiers */
    async key(k, o = {}) {
      const [code, keyCode, text0] = keyInfo(k);
      const text = o.ctrl || o.alt || o.meta ? undefined : text0 && o.shift && text0.length === 1 ? text0.toUpperCase() : text0;
      const base = { key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mods(o) };
      await send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text, unmodifiedText: text } : {}) });
      await pause(20);
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      await pause(o.after ?? 150);
    },
    async type(s) { for (const ch of s) await t.key(ch, { after: 40 }); await pause(150); },
    esc: () => t.key('Escape'),
    /** another tab in front for ms (the app's window loses focus), then this one again */
    async blurWindow(ms = 400, during) {
      await send('Emulation.setFocusEmulationEnabled', { enabled: false });
      const other = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
      try {
        await fetch(CDP + '/json/activate/' + other.id); await pause(ms);
        if (during) await during(other);
      } finally {
        await fetch(CDP + '/json/close/' + other.id).catch(() => {});
        await send('Page.bringToFront'); await pause(300);
        await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      }
    },
    /** the button is let go in another tab: this tab never sees the release */
    async releaseInOtherTab() {
      buttons = 0;
      await t.blurWindow(300, async (other) => {
        const ws = new WebSocket(other.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 10, y: 10, button: 'left', buttons: 0, clickCount: 1 } }));
        await pause(100); ws.close();
      });
    },
    /** centre (and box) of the first visible element matching selector, or null */
    el: (selector) => evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getBoundingClientRect().width);
      if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`),
    /** a command's toolbar or ribbon button on screen */
    button: (cmd) => t.el(`[data-cmd="${cmd}"]`),
    /** click the rows of the open menus labelled so, in turn (the newest menu first; a final "…" or "..." ignored) */
    async pick(...labels) {
      for (const label of labels) {
        const p = await evaluate(`(() => { const rows = [...document.querySelectorAll('.menu .m-item')].filter((r) => r.getBoundingClientRect().width).reverse();
          const r = rows.find((r) => r.querySelector('.m-lbl').textContent.replace(/(\\.\\.\\.|…)$/, '').trim() === ${JSON.stringify(label)});
          if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; })()`);
        assert.ok(p, `the menu offers ${label}`);
        await t.click(p);
      }
    },
    /** a menu of the menu bar (the Classic and Paper looks), then its rows: t.menu('Format', 'Font') */
    async menu(name, ...labels) {
      const m = await evaluate(`(() => { const m = [...document.querySelectorAll('.mb-item')].find((m) => m.textContent.replace(/&/g, '').trim() === ${JSON.stringify(name)});
        if (!m) return null; const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      assert.ok(m, `the ${name} menu`);
      await t.click(m);
      await t.pick(...labels);
    },
    /** the labels of the open menus' rows */
    menuItems: () => evaluate(`[...document.querySelectorAll('.menu .m-lbl')].map((e) => e.textContent)`),
    /** the brush cursor (Format Painter, highlighter) is showing */
    painting: () => evaluate(`!!document.querySelector('.painting')`),
    /** what has the keyboard: the focused element's id, else its class, else its tag */
    focused: () => evaluate(`(() => { const a = document.activeElement; return a ? (a.id || (typeof a.className === 'string' && a.className) || a.tagName) : null; })()`),
    /** no console errors and no request off 127.0.0.1 so far */
    clean() { assert.deepEqual(page.errors, [], 'browser errors'); assert.deepEqual(page.requests, [], 'external requests'); },
  };
  return t;
}
