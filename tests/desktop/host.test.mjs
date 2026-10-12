// VO.host (public/common/suite.js), the pages' side of the desktop app's host interface (docs/desktop.md):
// with the desktop host (tests/desktop/host-stub.js) a file Windows starts us with opens in its app and
// no service worker is registered, the version is the app's and links go to the system; in a browser the
// host is 'web'. The update policies (updater/current.json) and what is new (updater/whatsnew.json); versions
// compare by date (VO.compareVersions).
//
//   node --test tests/desktop/host.test.mjs   (needs Chromium with CDP at 127.0.0.1:9222, as tools/shot.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const shot = (page, steps, ...args) => {
  const out = execFileSync('node', [path.join(root, 'tools/shot.mjs'), page, JSON.stringify(steps), ...args], { encoding: 'utf8' });
  const line = out.split('\n').findLast((l) => l.startsWith('js -> '));   // the last step's result
  assert.ok(line, out);
  return { out, r: JSON.parse(JSON.parse(line.slice(6))) };
};
const state = `return JSON.stringify({ path: location.pathname, title: document.title, kind: VO.host.kind,
  platform: VO.host.platform, version: VO.VERSION, newWindow: sessionStorage.newWindow || '', calls: sessionStorage.hostCalls || '', sw: sessionStorage.swRegister || '' });`;

test('desktop: the launch file opens in its app, once', () => {
  const { out, r } = shot('', [{ wait: 3000 }, { js: state }], '--pre', path.join(root, 'tests/desktop/host-stub.js'));
  assert.equal(r.path, '/ledger/', 'Budget.csv went to Ledger');
  assert.match(r.title, /^Budget/);
  assert.equal(r.kind, 'desktop');
  assert.equal(r.platform, 'windows');
  assert.match(r.newWindow, /\/ledger\/\?open=/, 'Ledger opened in a window of its own');
  assert.equal(r.calls, '/ / /', 'the Start Center listed and read the file and opened Ledger\'s window; Ledger asked for nothing');
  assert.equal(r.sw, '', 'no service worker in the desktop app');
  assert.equal(r.version, 'v2026.10.11-abc123', 'the desktop build\'s version');
  assert.match(out, /no errors, no external requests/);
  // leave this browser's Recent Files as they were
  shot('', [{ js: `await VO.recent.remove('ledger:Budget.csv'); return '1'` }]);
});

test('desktop: a file another start of the app hands over opens in its app (one instance, Windows)', () => {
  const { out, r } = shot('', [{ js: `__stubSecondStart('Notes.md', '# Notes\\n\\nHello'); return '1'`, wait: 2500 }, { js: state }],
    '--pre', path.join(root, 'tests/desktop/host-stub.js'), '--qs', 'nolaunch');
  assert.equal(r.path, '/quire/', 'Notes.md went to Quire');
  assert.match(r.newWindow, /\/quire\/\?open=/, 'Quire opened in a window of its own');
  assert.match(r.title, /^Notes/);
  assert.match(out, /no errors, no external requests/);
  shot('', [{ js: `await VO.recent.remove('quire:Notes.md'); return '1'` }]);
});

test('desktop: File > Exit closes an app window', () => {
  const { r } = shot('quire/', [{ js: `await VO.exit(); await new Promise((r) => setTimeout(r, 300));
    return JSON.stringify({ closed: sessionStorage.closed || '', path: location.pathname });` }], '--pre', path.join(root, 'tests/desktop/host-stub.js'), '--qs', 'nolaunch');
  assert.deepEqual(r, { closed: '/quire/', path: '/quire/' });
});

test('desktop: About > Open source licenses opens the credits page in a window of its own', () => {
  const { r } = shot('', [{ js: `document.getElementById('about').click(); document.getElementById('osslink').click(); return '1'`, wait: 800 },
    { js: `return JSON.stringify({ newWindow: sessionStorage.newWindow || '', title: document.title })` }],
  '--pre', path.join(root, 'tests/desktop/host-stub.js'), '--qs', 'nolaunch');
  assert.match(r.newWindow, /\/oss-licenses\.html$/);
  assert.match(r.title, /^Open source licenses/);
});

test('desktop: a save says where it went, and Browse shows it', () => {
  const { r } = shot('quire/', [{ js: `
    const toast = () => { const t = document.querySelector('.toast'); return t && !t.hidden ? t.textContent : ''; };
    window.dispatchEvent(new CustomEvent('vo-download', { detail: { ok: true, name: 'Report (2).docx' } }));
    const saved = toast();
    document.querySelector('.toast .toast-act').click();
    await new Promise((r) => setTimeout(r, 200));
    window.dispatchEvent(new CustomEvent('vo-download', { detail: { ok: false, name: null } }));
    return JSON.stringify({ saved, browsed: sessionStorage.browsed || '', failed: toast(), button: !!document.querySelector('.toast .toast-act') });` }],
  '--pre', path.join(root, 'tests/desktop/host-stub.js'), '--qs', 'nolaunch');
  assert.deepEqual(r, { saved: 'Saved to Downloads folder: Report (2).docx Browse', browsed: 'null',
    failed: 'The file could not be saved to the Downloads folder.', button: false });
});

test('desktop: openUrl goes to the system', () => {
  const { r } = shot('', [{ js: `await VO.host.openUrl('https://github.com/tcchen2026/VibeOffice');
    let bad = ''; try { await VO.host.openUrl('file:///C:/Windows/notepad.exe'); } catch (e) { bad = String(e); }
    return JSON.stringify({ opened: sessionStorage.opened, bad });` }], '--pre', path.join(root, 'tests/desktop/host-stub.js'), '--qs', 'nolaunch');
  assert.equal(r.opened, 'https://github.com/tcchen2026/VibeOffice');
  assert.match(r.bad, /not a web or mail address/);
});

const settings = `document.getElementById('settings').click(); await new Promise((r) => setTimeout(r, 400));
  const out = { row: !document.getElementById('scalerow').hidden, hint: !document.getElementById('scaleweb').hidden, value: document.getElementById('uiscale').value };
  if (out.row) { const s = document.getElementById('uiscale'); s.value = '2'; s.dispatchEvent(new Event('change')); await new Promise((r) => setTimeout(r, 200)); out.saved = sessionStorage.uiScale;
    let bad = ''; try { await VO.host.setUiScale(9); } catch (e) { bad = String(e); } out.bad = bad; }
  return JSON.stringify(out);`;

test('desktop: Settings sets the UI size', () => {
  const { r } = shot('', [{ js: settings }], '--pre', path.join(root, 'tests/desktop/host-stub.js'), '--qs', 'nolaunch');
  assert.deepEqual(r, { row: true, hint: false, value: '1', saved: '2', bad: 'UI scale 9 is outside 0.5..4' });
});

test('web: Settings points to the browser\'s zoom', () => {
  const { r } = shot('', [{ js: settings }]);
  assert.deepEqual(r, { row: false, hint: true, value: '1' });
});

const update = `await new Promise((r) => setTimeout(r, 500));
  const out = { button: !document.getElementById('update').hidden, dialog: document.getElementById('updatedlg').open };
  if (out.dialog) out.news = [...document.querySelectorAll('#updatenews > *')].map((e) => e.textContent);
  if (out.dialog) { const d = document.getElementById('updatedlg'); d.querySelector('button[value=download]').click(); }
  else if (out.button) document.getElementById('update').click();
  await new Promise((r) => setTimeout(r, 200));
  out.opened = sessionStorage.opened || '';
  localStorage.removeItem('vibeoffice.updateAsked');
  return JSON.stringify(out);`;
const stub = path.join(root, 'tests/desktop/host-stub.js');
const URL_ = 'https://vibeoffice.work/updater/?from_version=v2026.10.11-abc123&current_platform=windows';

test('desktop: up to date, no Update button', () => {
  const { r } = shot('', [{ js: update }], '--pre', stub, '--qs', 'nolaunch');
  assert.deepEqual(r, { button: false, dialog: false, opened: '' });
});

test('desktop: show-update-button shows the button, which opens the updater page', () => {
  const { r } = shot('', [{ js: update }], '--pre', stub, '--qs', 'nolaunch&update=button');
  assert.deepEqual(r, { button: true, dialog: false, opened: URL_ });
});

test('desktop: show-update-dialog asks with a dialog, with what is new', () => {
  const { r } = shot('', [{ js: update }], '--pre', stub, '--qs', 'nolaunch&update=dialog');
  assert.deepEqual(r, { button: true, dialog: true, opened: URL_,
    news: ['v2026.10.14-000000', 'Fourteenth.', 'v2026.10.12-000000', 'Twelfth.\nSecond line.'] }, 'what is new since this version, newest first');
});

test('the published updater/current.json: a build from 10-08 gets the button, 10-01 the dialog, today\'s nothing', () => {
  for (const [version, want] of [['v2026.10.08-000000', { button: true, dialog: false }], ['v2026.10.01-000000', { button: true, dialog: true }],
    ['v2026.10.11-32d7b2', { button: false, dialog: false }]]) {
    const { r } = shot('', [{ js: update }], '--pre', stub, '--qs', `nolaunch&version=${version}`);
    assert.deepEqual({ button: r.button, dialog: r.dialog }, want, version);
  }
});

test('web: no update check', () => {
  const { r } = shot('', [{ js: update }]);
  assert.deepEqual(r, { button: false, dialog: false, opened: '' });
});

test('versions compare by date alone', () => {
  const { r } = shot('', [{ js: `const c = VO.compareVersions; return JSON.stringify({
    older: c('v2026.10.10-ffffff', 'v2026.10.11-000000'), same: c('v2026.10.11-abc123', 'v2026.10.11-def456'),
    newer: c('v2026.11.01-abc123', 'v2026.10.31-abc123'), year: c('v2027.01.01-abc123', 'v2026.12.31-abc123'),
    legacy: c('2026.10.8f8494', 'v2026.10.01-abc123'), upper: c('V2026.10.11-abc123', 'v2026.10.11-def456'), devNewest: c('dev', 'v2099.12.31-abc123'), devDev: c('dev', 'dev'),
    web: VO.VERSION, label: document.querySelector('.version').parentNode.textContent.includes('Ver.') });` }]);
  assert.deepEqual(r, { older: -1, same: 0, newer: 1, year: 1, legacy: -1, upper: 0, devNewest: 1, devDev: 0, web: 'dev', label: false });
});

test('web: the host is the browser', () => {
  const { out, r } = shot('', [{ js: state }]);
  assert.equal(r.kind, 'web');
  assert.equal(r.platform, 'web');
  assert.equal(r.path, '/');
  assert.match(out, /no errors, no external requests/);
});
