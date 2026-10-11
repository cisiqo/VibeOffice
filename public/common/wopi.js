/* Optional WOPI client transport. The normal static site does not set __VO_WOPI__ and this file is inert.
 * A WOPI gateway injects { session, info } before suite.js; all browser requests then stay same-origin and
 * the gateway keeps the access token out of the URL and browser storage.
 */
(function () {
  'use strict';
  const boot = window.__VO_WOPI__;
  const VO = window.VO;
  if (!boot || !boot.session || !VO) return;
  const writable = (i) => boot.action !== 'view' && !!(i && i.UserCanWrite === true && i.SupportsUpdate === true);
  document.documentElement.dataset.wopi = writable(boot.info) ? 'edit' : 'readonly';

  const base = '/wopi/session/' + encodeURIComponent(boot.session);
  const native = {
    quire: new Set(['docx', 'docm', 'dotx', 'dotm']),
    ledger: new Set(['xlsx', 'xlsm', 'xltx', 'xltm']),
    lectern: new Set(['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm']),
  };
  let app = null, hooks = null, info = boot.info || null;
  let lock = null, refreshTimer = 0, ready = false, saving = null;
  let lastEditNotice = 0;

  function ext(name) {
    const m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  function message(id, values) {
    if (window.parent === window) return;
    window.parent.postMessage(JSON.stringify({ MessageId: id, SendTime: Date.now(), Values: values || {} }), info && info.PostMessageOrigin || '*');
  }
  function errorText(body, fallback) {
    if (!body) return fallback;
    try {
      const o = JSON.parse(body);
      return o.error || o.message || fallback;
    } catch (_) {
      return body.slice(0, 500) || fallback;
    }
  }
  async function request(path, options) {
    const r = await fetch(base + path, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, options));
    if (!r.ok) throw new Error(errorText(await r.text(), `WOPI request failed (${r.status})`));
    return r;
  }
  async function command(action) {
    const r = await request('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, lock }),
      keepalive: action === 'unlock',
    });
    return r.json();
  }
  async function ensureLock() {
    if (!info.SupportsLocks || lock) return;
    lock = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    try {
      await command('lock');
    } catch (e) {
      lock = null;
      throw e;
    }
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => command('refresh').catch((e) => console.warn('WOPI lock refresh:', e.message)), 10 * 60 * 1000);
  }
  async function releaseLock() {
    if (!lock) return;
    clearInterval(refreshTimer);
    try { await command('unlock'); } catch (e) { console.warn('WOPI unlock:', e.message); }
    lock = null;
  }

  VO.wopi = {
    active: true,
    get info() { return info; },
    handles(name) { return !!(ready && app && native[app] && native[app].has(ext(name))); },
    opened() {},
    async attach(appId, appHooks) {
      app = appId;
      hooks = appHooks;
      info = info || await (await request('/info')).json();
      const fileExt = ext(info.BaseFileName);
      if (!native[app] || !native[app].has(fileExt)) throw new Error(`${info.BaseFileName} is not supported by ${VO.APPS[app].name}.`);
      const blob = await (await request('/contents')).blob();
      const file = new File([blob], info.BaseFileName, { type: blob.type || 'application/octet-stream', lastModified: Date.now() });
      file.voWopi = true;
      await hooks.open(file, { wopi: true, saved: true, readOnly: info.UserCanWrite === false });
      if (hooks.setReadOnly) hooks.setReadOnly(!writable(info));
      ready = true;
      document.documentElement.dataset.wopi = writable(info) ? 'edit' : 'readonly';
      message('App_LoadingStatus', { DocumentLoadedTime: Date.now() });
      if (boot.saveAs && writable(info)) setTimeout(() => { if (window.L && L.ui) L.ui.exec('saveAs'); }, 0);
    },
    changed() {
      if (!info.EditNotificationPostMessage || Date.now() - lastEditNotice < 5 * 60 * 1000) return;
      lastEditNotice = Date.now();
      message('Edit_Notification');
    },
    async save(name, blob) {
      if (!this.handles(name)) return null;
      if (!writable(info)) throw new Error('This WOPI file is read-only.');
      if (saving) return saving;
      saving = (async () => {
        const relative = name !== info.BaseFileName;
        if (relative && info.UserCanNotWriteRelative === true) throw new Error('This WOPI host does not allow Save As.');
        if (relative) await releaseLock();
        else await ensureLock();
        const q = relative ? '?relative=' + encodeURIComponent(name) : '';
        const r = await request('/contents' + q, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, lock ? { 'X-VO-WOPI-Lock': lock } : {}),
          body: blob,
        });
        const out = await r.json();
        if (out.Relative) { clearInterval(refreshTimer); lock = null; }
        if (out.Name) {
          info.BaseFileName = out.Name;
          if (relative) message('File_Rename', { NewName: out.Name });
        }
        if (out.Version) info.Version = out.Version;
        return 'saved';
      })();
      try { return await saving; }
      catch (e) { throw e; }
      finally { saving = null; }
    },
    close: releaseLock,
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !info || e.origin !== info.PostMessageOrigin) return;
    let m = e.data;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch (_) { return; } }
    if (!m || !m.MessageId) return;
    if (m.MessageId === 'Host_PostmessageReady' && ready) message('App_LoadingStatus', { DocumentLoadedTime: Date.now() });
  });
  window.addEventListener('pagehide', () => { if (lock) releaseLock(); });

  /* The editor models remain the primary read-only boundary. This capture guard also stops browser-native
     editing and mutating shortcuts before app handlers see them, while preserving navigation and search. */
  const refuse = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  for (const type of ['beforeinput', 'cut', 'paste', 'drop']) {
    document.addEventListener(type, (e) => { if (document.documentElement.dataset.wopi === 'readonly') refuse(e); }, true);
  }
  document.addEventListener('keydown', (e) => {
    if (document.documentElement.dataset.wopi !== 'readonly') return;
    const t = e.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const key = e.key;
    const nav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab', 'Escape', 'Enter', 'F1', 'F5'].includes(key);
    const safeCtrl = (e.ctrlKey || e.metaKey) && ['a', 'c', 'f', 'p', '+', '-', '0', 'PageUp', 'PageDown'].includes(key);
    if (!nav && !safeCtrl) refuse(e);
  }, true);
})();
