// The service worker (public/sw.js) with the published site's files (tools/web-release.sh), in the Chromium at CDP
// 127.0.0.1:9222. Staged copies of public/ are served on 127.0.0.1 (an allowed origin), on a port of their own:
// first install and its progress, offline pages, an update (the new version's zip) while an open page keeps its
// version, old caches going once no page uses them, a damaged zip failing the install, and no worker on any other
// origin.
//
//   node --test tests/sw.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CDP = process.env.CDP || 'http://127.0.0.1:9222';
const work = path.join(root, 'tmp', 'sw-test');
const V1 = 'v2026.10.11-aaaaa1', V2 = 'v2026.10.12-aaaaa2', V3 = 'v2026.10.13-aaaaa3';
const log = process.env.SW_TEST_LOG ? (...a) => console.error('[sw-test]', ...a) : () => {};

/** a copy of public/ published as version; change(dir) edits it first */
function stage(name, version, change) {
  const dir = path.join(work, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(root, 'public'), dir, { recursive: true });
  if (change) change(dir);
  execFileSync(path.join(root, 'tools', 'web-release.sh'), [dir, version], { stdio: 'pipe' });
  return dir;
}

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', woff2: 'font/woff2', webmanifest: 'application/manifest+json', zip: 'application/zip' };
/** a static server like the published one: index.html redirects to its folder; `site.dir` can change, `site.offline`
 *  drops every connection; `site.log` lists the paths asked for */
function server() {
  const site = { dir: null, offline: false, log: [] };
  const srv = http.createServer((req, res) => {
    if (site.offline) { req.socket.destroy(); return; }
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    site.log.push(p);
    if (p.endsWith('/index.html')) { res.writeHead(308, { Location: p.slice(0, -'index.html'.length) }); res.end(); return; }
    const file = path.join(site.dir, p.endsWith('/') ? p + 'index.html' : p);
    if (!file.startsWith(site.dir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).slice(1)] || 'text/plain', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    site.origin = `http://127.0.0.1:${srv.address().port}`;
    site.close = () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); });
    resolve(site);
  }));
}

/** a new tab over CDP: send(method, params), js(expression) → its value (awaited), go(url), close() */
async function tab(url) {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  log('tab', t.id);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let n = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (!d.id || !pending.has(d.id)) return;
    const { resolve, reject } = pending.get(d.id);
    pending.delete(d.id);
    if (d.error) reject(new Error(d.error.message)); else resolve(d.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await js(expression); } catch (e) { /* the page is loading */ }
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out waiting for ' + what);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const go = async (to) => {
    log('go', to);
    await send('Page.navigate', { url: to });
    await new Promise((r) => setTimeout(r, 200));
    await until("document.readyState === 'complete' && !!window.VO", 'the page at ' + to);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  /* every 'vo-cache' the page hears, from its first script on */
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__voCache = []; addEventListener('vo-cache', (e) => __voCache.push(e.detail));" });
  const close = async () => { try { ws.close(); } catch (e) { /* gone */ } await fetch(`${CDP}/json/close/${t.id}`).catch(() => {}); };
  const x = { send, js, until, go, close };
  if (url) await go(url).catch(async (e) => { await close(); throw e; });
  return x;
}

const cacheNames = "caches.keys().then((k) => k.sort().join(' '))";
const cssOf = "fetch('common/ui.css').then((r) => r.text()).then((t) => t.includes('/* v2 */') ? 'v2' : 'v1')";

test('the service worker caches the published site, a version per page', { timeout: 180000 }, async (t) => {
  const site = await server();
  const tabs = [];
  t.after(async () => {
    const z = await tab();   // the origin's worker, caches and storage go, whatever happened
    await z.send('Storage.clearDataForOrigin', { origin: site.origin, storageTypes: 'all' }).catch(() => {});
    await z.close();
    for (const x of tabs) await x.close();
    /* and any tab still on the test's origin (a close that raced a reload) */
    for (const t of await (await fetch(`${CDP}/json/list`)).json()) {
      if (t.type === 'page' && t.url.startsWith(site.origin)) await fetch(`${CDP}/json/close/${t.id}`).catch(() => {});
    }
    await site.close();
    fs.rmSync(work, { recursive: true, force: true });
  });
  const open = async (url) => { const x = await tab(url); tabs.push(x); return x; };
  const v1 = stage('v1', V1);
  const v2 = stage('v2', V2, (dir) => fs.appendFileSync(path.join(dir, 'common', 'ui.css'), '\n/* v2 */\n'));
  /* the files of the site, as packed: all but sw.js and updater/ */
  const count = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => f !== 'sw.js' && !f.startsWith('updater') && fs.statSync(path.join(dir, f)).isFile()).length;

  /* first visit: installs, reports progress, takes the page over */
  site.dir = v1;
  const a = await open();
  await a.send('Storage.clearDataForOrigin', { origin: site.origin, storageTypes: 'all' });
  await a.go(site.origin + '/');
  await a.until('!!navigator.serviceWorker.controller', 'the worker to control the page');
  assert.equal(await a.js(cacheNames), `vibeoffice-clients vibeoffice-${V1}`);
  assert.equal(await a.js(`caches.open('vibeoffice-${V1}').then((c) => c.keys()).then((k) => k.length)`), count(v1));
  assert.equal(await a.js(`caches.match('${site.origin}/common/ui.css').then((r) => r.headers.get('Content-Type'))`), 'text/css; charset=utf-8');
  const first = await a.js('__voCache');
  assert.ok(first.some((d) => d.state === 'progress' && d.update === false), 'progress on the first install');
  assert.equal(first.at(-1).state, 'done');

  assert.ok(first.some((d) => d.state === 'progress' && d.total > 0 && d.received === d.total), 'progress tells the bytes');

  /* the Start Center's bar, and its reload button after an update (none after a first visit) */
  const bar = `['caching', 'cachingtext', 'cachingsize', 'cachingbar', 'cachingreload'].map((id) => {
    const e = document.getElementById(id); return id === 'cachingbar' ? e.value : id === 'caching' || id === 'cachingreload' ? e.hidden : e.textContent; }).join('|')`;
  const say = (detail) => a.js(`(dispatchEvent(new CustomEvent('vo-cache', { detail: ${JSON.stringify(detail)} })), ${bar})`);
  assert.equal(await say({ state: 'progress', update: true, progress: 0.5, received: 2097152, total: 4194304 }), 'false|Updating cached resources|2.0 of 4.0 MB|0.5|true');
  assert.equal(await say({ state: 'progress', update: false, progress: 0.1, received: 524288, total: 0 }), 'false|Caching resources for offline use|0.5 MB|0.1|true');
  assert.match(await say({ state: 'done', update: false }), /^true\|.*\|true$/, 'a first visit: nothing to reload');
  assert.match(await say({ state: 'done', update: true }), /^true\|.*\|false$/, 'an update: the reload button');
  assert.match(await say({ state: 'failed', update: true }), /^true\|.*\|true$/, 'failed: neither');

  /* offline: the Start Center and an app still open, from the cache */
  site.offline = true;
  await a.go(site.origin + '/');
  assert.equal(await a.js('VO.VERSION'), V1);
  await a.go(site.origin + '/quire');   // a folder without its slash
  assert.equal(await a.js('location.pathname'), '/quire/');
  await a.until('!!(window.L && L.app)', 'Quire offline');
  await a.go(site.origin + '/quire/?new');   // a query is ignored
  await a.until('!!(window.L && L.app)', 'Quire ?new offline');
  await a.go(site.origin + '/nowhere/');   // not a page of the site: the Start Center
  assert.equal(await a.js('location.pathname'), '/');
  site.offline = false;

  /* an update while the page is open: the new version's zip, nothing else; the open page keeps v1 */
  site.dir = v2;
  site.log = [];
  await a.js('navigator.serviceWorker.getRegistration().then((r) => r.update())');
  await a.until(`caches.keys().then((k) => k.includes('vibeoffice-${V2}') && !!navigator.serviceWorker.controller) && __voCache.some((d) => d.state === 'done' && d.update)`, 'the update');
  await a.until(`navigator.serviceWorker.getRegistration().then((r) => r.active && !r.waiting && !r.installing)`, 'the new worker to take over');
  assert.ok((await a.js('__voCache')).some((d) => d.state === 'progress' && d.update === true), 'progress says update');
  assert.equal(await a.js("document.getElementById('cachingreload').hidden"), false, 'the Just updated notice');
  const fetched = site.log.filter((p) => p !== '/sw.js' && p !== '/common/zip.js');   // the worker's own scripts, compared for the update
  assert.deepEqual(fetched, [`/updater/web-${V2}.zip`]);
  assert.equal(await a.js(cssOf), 'v1', 'the open page keeps its version');
  /* the browser stops idle workers: the restarted one still knows which version the open page uses */
  await a.send('ServiceWorker.enable');
  await a.send('ServiceWorker.stopAllWorkers');
  assert.equal(await a.js(cssOf), 'v1', 'the open page keeps its version after the worker restarts');
  assert.equal(await a.js(cacheNames), `vibeoffice-clients vibeoffice-${V1} vibeoffice-${V2}`);

  /* a new page gets v2; once the v1 page has gone, its cache goes on the next navigation */
  const b = await open(site.origin + '/');
  assert.equal(await b.js('VO.VERSION'), V2);
  assert.equal(await b.js(cssOf), 'v2');
  assert.equal(await a.js(cssOf), 'v1');
  /* Just updated, Click here to reload: the open page reloads in the new version */
  await a.js("document.getElementById('cachingreload').click()");
  await a.until(`window.VO && VO.VERSION === '${V2}' && document.readyState === 'complete'`, 'the reload in v2');
  assert.equal(await a.js(cssOf), 'v2');
  await a.close();
  tabs.splice(tabs.indexOf(a), 1);
  await b.go(site.origin + '/');
  await b.until(`caches.keys().then((k) => !k.includes('vibeoffice-${V1}'))`, 'the v1 cache to go');
  assert.equal(await b.js(cacheNames), `vibeoffice-clients vibeoffice-${V2}`);

  /* a damaged zip (one byte changed inside a packed file) fails the install: no cache, v2 goes on serving */
  const v3 = stage('v3', V3);
  const pack = path.join(v3, 'updater', `web-${V3}.zip`), bytes = fs.readFileSync(pack);
  bytes[bytes.length >> 1] ^= 0xff;
  fs.writeFileSync(pack, bytes);
  site.dir = v3;
  await b.js('navigator.serviceWorker.getRegistration().then((r) => r.update()).catch(() => null)');
  await b.until("__voCache.some((d) => d.state === 'failed')", 'the install to fail');
  const why = (await b.js('__voCache')).find((d) => d.state === 'failed').error;
  log('the damaged zip:', why);
  assert.match(why, /damaged|invalid|incorrect|decompress|inflate/i, 'the failure says why');
  await b.until(`navigator.serviceWorker.getRegistration().then((r) => !r.installing && !r.waiting)`, 'the failed worker to go');
  assert.equal(await b.js(cacheNames), `vibeoffice-clients vibeoffice-${V2}`);
  await b.go(site.origin + '/');
  assert.equal(await b.js('VO.VERSION'), V2);
});

test('no service worker on any other origin', { timeout: 60000 }, async (t) => {
  const site = await server();
  const x = await tab();
  t.after(async () => { await x.close(); await site.close(); fs.rmSync(path.join(work, 'elsewhere'), { recursive: true, force: true }); });
  const elsewhere = site.origin.replace('127.0.0.1', 'localhost');   // the same server, not an allowed origin
  site.dir = stage('elsewhere', V1);
  await x.go(elsewhere + '/');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await x.js('navigator.serviceWorker.getRegistrations().then((r) => r.length)'), 0);
  assert.equal(await x.js(cacheNames), '');
  assert.ok(!site.log.includes('/sw.js'), 'sw.js never asked for');
  await x.send('Storage.clearDataForOrigin', { origin: elsewhere, storageTypes: 'all' });
});
