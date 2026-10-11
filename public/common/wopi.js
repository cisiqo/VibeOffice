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
  let recoveringLock = null;
  let eventRevision = 0, stopEvents = false, remoteChanged = false;
  let lastEditNotice = 0;

  function ext(name) {
    const m = /\.([^.]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }
  function message(id, values) {
    if (window.parent === window || !info || !info.PostMessageOrigin) return;
    window.parent.postMessage(JSON.stringify({ MessageId: id, SendTime: Date.now(), Values: values || {} }), info.PostMessageOrigin);
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
  class WopiRequestError extends Error {
    constructor(status, details, fallback) {
      super(details.error || details.message || fallback);
      this.name = 'WopiRequestError';
      this.status = status;
      Object.assign(this, details);
    }
  }
  async function request(path, options) {
    const r = await fetch(base + path, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, options));
    if (!r.ok) {
      const text = await r.text();
      let details = {};
      try { details = JSON.parse(text); } catch (_) { details.error = errorText(text, `WOPI request failed (${r.status})`); }
      if (r.status === 401) details.error = (details.error || 'The access token expired.') + ' Open the file again.';
      throw new WopiRequestError(r.status, details, `WOPI request failed (${r.status})`);
    }
    return r;
  }
  async function command(action, values) {
    const r = await request('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action, lock }, values || {})),
      keepalive: action === 'unlock',
    });
    return r.json();
  }
  function newLock() {
    return boot.coauthorLock || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  }
  function startRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => maintainLock().catch((e) => console.warn('WOPI lock refresh:', e.message)), 10 * 60 * 1000);
  }
  async function recoverLock() {
    if (recoveringLock) return recoveringLock;
    recoveringLock = (async () => {
      if (!lock) throw new Error('There is no WOPI lock to recover.');
      const state = await command('getLock', { lock: '' });
      if (!state.Lock) {
        await command('lock');
      } else if (state.Lock === lock) {
        await command('refresh');
      } else {
        throw new WopiRequestError(409, {
          code: 'lock_conflict',
          currentLock: state.Lock,
          error: 'Another editor owns the WOPI file lock.',
        }, 'The WOPI lock could not be recovered.');
      }
      startRefresh();
    })();
    try { await recoveringLock; } finally { recoveringLock = null; }
  }
  async function maintainLock() {
    if (!lock) return;
    try {
      await command('refresh');
      startRefresh();
    } catch (_) {
      await recoverLock();
    }
  }
  async function ensureLock() {
    if (!info.SupportsLocks) return;
    if (lock) return maintainLock();
    lock = newLock();
    try {
      await command('lock');
    } catch (e) {
      lock = null;
      throw e;
    }
    startRefresh();
  }
  async function releaseLock() {
    if (!lock) return;
    clearInterval(refreshTimer);
    try { await command('unlock'); } catch (e) { console.warn('WOPI unlock:', e.message); }
    lock = null;
  }
  async function pollEvents() {
    while (!stopEvents) {
      try {
        const event = await (await request('/events?since=' + eventRevision)).json();
        eventRevision = Math.max(eventRevision, Number(event.revision) || 0);
        if (event.origin && event.origin !== boot.session) {
          if (event.kind === 'save') {
            const dirty = !!(hooks && hooks.isDirty && hooks.current && hooks.isDirty(hooks.current()));
            if (dirty) {
              remoteChanged = true;
              (hooks.message || window.alert)('Another editor saved a newer version. Your next save will offer a conflict copy.');
            } else {
              location.replace(base + '/reload');
              return;
            }
          } else if (event.kind === 'rename' && event.name) {
            info.BaseFileName = event.name;
            if (hooks && hooks.renamed) hooks.renamed(event.name);
          } else if (event.kind === 'delete') {
            ready = false;
            (hooks && hooks.message || window.alert)('Another editor deleted this file.');
          }
        }
      } catch (e) {
        if (!stopEvents) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
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
      if (boot.frameTrust) message('App_IsFrameTrusted');
      pollEvents();
      if (boot.saveAs && writable(info)) setTimeout(() => { if (window.L && L.ui) L.ui.exec('saveAs'); }, 0);
    },
    changed() {
      if (!info.EditNotificationPostMessage || Date.now() - lastEditNotice < 5 * 60 * 1000) return;
      lastEditNotice = Date.now();
      message('Edit_Notification');
    },
    get canRename() {
      return !!(ready && writable(info) && info.SupportsRename === true);
    },
    get canDelete() {
      return !!(ready && writable(info) && info.UserCanDelete === true);
    },
    async rename(name) {
      if (!this.canRename) throw new Error('This WOPI host does not allow Rename.');
      const requested = String(name || '').trim();
      if (!requested || /[\\/]/.test(requested)) throw new Error('Enter a valid file name.');
      if (ext(requested) !== ext(info.BaseFileName)) throw new Error('Rename must keep the current file extension.');
      await ensureLock();
      const out = await command('rename', { name: requested });
      info.BaseFileName = out.Name;
      if (out.Version) info.Version = out.Version;
      if (Number.isFinite(out.Size)) info.Size = out.Size;
      if (out.SHA256) info.SHA256 = out.SHA256;
      if (hooks && hooks.renamed) hooks.renamed(out.Name);
      message('File_Rename', { NewName: out.Name });
      return out.Name;
    },
    async renameDialog() {
      const requested = window.prompt('New file name:', info.BaseFileName);
      if (requested == null || requested.trim() === info.BaseFileName) return;
      try {
        await this.rename(requested);
      } catch (e) {
        (hooks && hooks.message || window.alert)(`The WOPI file could not be renamed. ${e.message || e}`);
      }
    },
    async deleteFile() {
      if (!this.canDelete) throw new Error('This WOPI host does not allow Delete.');
      await releaseLock();
      await command('delete', { lock: '' });
      ready = false;
      document.documentElement.dataset.wopi = 'readonly';
      if (hooks && hooks.deleted) hooks.deleted();
      if (info.ClosePostMessage === true) message('UI_Close');
      else if (window.VO && VO.exit) await VO.exit();
    },
    async deleteDialog() {
      if (!window.confirm(`Permanently delete “${info.BaseFileName}”?`)) return;
      try {
        await this.deleteFile();
      } catch (e) {
        (hooks && hooks.message || window.alert)(`The WOPI file could not be deleted. ${e.message || e}`);
      }
    },
    requestHostUI(kind, values) {
      const commands = {
        edit: ['UI_Edit', 'EditModePostMessage'],
        embed: ['UI_FileEmbed', 'FileEmbedCommandPostMessage'],
        versions: ['UI_FileVersions', 'FileVersionPostMessage'],
        sharing: ['UI_Sharing', 'FileSharingPostMessage'],
        workflow: ['UI_Workflow', 'WorkflowPostMessage'],
      };
      const commandInfo = commands[kind];
      if (!commandInfo || info[commandInfo[1]] !== true) return false;
      message(commandInfo[0], values);
      return true;
    },
    async save(name, blob) {
      if (!this.handles(name)) return null;
      if (!writable(info)) throw new Error('This WOPI file is read-only.');
      if (saving) return saving;
      saving = (async () => {
        const relative = name !== info.BaseFileName;
        if (relative && info.UserCanNotWriteRelative === true) throw new Error('This WOPI host does not allow Save As.');
        const put = async (target, isRelative) => {
          if (isRelative) await releaseLock();
          else await ensureLock();
          const q = isRelative ? '?relative=' + encodeURIComponent(target) : '';
          const r = await request('/contents' + q, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, lock ? { 'X-VO-WOPI-Lock': lock } : {}),
            body: blob,
          });
          return r.json();
        };
        let out;
        try {
          out = await put(name, relative);
        } catch (e) {
          if (relative || !['version_conflict', 'network_conflict'].includes(e.code)) throw e;
          const dot = name.lastIndexOf('.');
          const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
          const conflictName = (dot > 0 ? name.slice(0, dot) : name) + ' (conflict ' + stamp + ')' + (dot > 0 ? name.slice(dot) : '');
          if (!window.confirm(`${e.message}\n\nSave your changes as “${conflictName}” instead?`)) throw e;
          out = await put(conflictName, true);
        }
        if (out.Relative) { clearInterval(refreshTimer); lock = null; }
        if (out.Name) {
          info.BaseFileName = out.Name;
          if (relative) message('File_Rename', { NewName: out.Name });
        }
        if (out.Version) info.Version = out.Version;
        if (Number.isFinite(out.Size)) info.Size = out.Size;
        if (out.SHA256) info.SHA256 = out.SHA256;
        remoteChanged = false;
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
    const values = m.Values && typeof m.Values === 'object' ? m.Values : {};
    if (m.MessageId === 'Host_PostmessageReady' && ready) {
      message('App_LoadingStatus', { DocumentLoadedTime: Date.now() });
    } else if (m.MessageId === 'Blur_Focus') {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    } else if (m.MessageId === 'Grab_Focus') {
      if (window.L && L.ui && L.ui.hooks && L.ui.hooks.refocus) L.ui.hooks.refocus();
    } else if (m.MessageId === 'App_PopState' && typeof values.Url === 'string') {
      try {
        const url = new URL(values.Url, location.href);
        if (url.origin === location.origin) history.replaceState(values.State || null, '', url.href);
      } catch (_) { /* malformed or cross-origin history state */ }
    } else if (m.MessageId === 'Host_PerfTiming') {
      VO.wopi.hostTiming = values;
    }
    window.dispatchEvent(new CustomEvent('vo-wopi-message', { detail: m }));
  });
  window.addEventListener('pagehide', () => { stopEvents = true; if (lock) releaseLock(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && lock) maintainLock().catch((e) => console.warn('WOPI lock recovery:', e.message));
  });

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
