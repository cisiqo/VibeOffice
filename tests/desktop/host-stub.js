// The desktop host (desktop/src/host.rs) as seen by the pages, for Chromium: run before each page's
// scripts with  node tools/shot.mjs '' steps.json --pre tests/desktop/host-stub.js
// The app was "started with" Budget.csv (not with ?nolaunch); launch files are taken once per tab, as once per process there.
// __stubSecondStart(name, text): another start of the app hands this one a file (main.rs, second_start).
// Records in sessionStorage: hostCalls (each command), opened (host_open_url), uiScale, newWindow, closed
// (host_close_window), swRegister (service worker registrations).
(() => {
  const files = [{ name: 'Budget.csv', text: 'Item,Cost\nRent,900\nFood,250\n' }];
  const later = [];   // handles a second start handed over
  window.__stubSecondStart = (name, text) => {
    later.push(files.push({ name, text }) - 1);
    window.dispatchEvent(new Event('vo-files'));
  };
  const log = (k) => { sessionStorage[k] = (sessionStorage[k] ? sessionStorage[k] + ' ' : '') + location.pathname; };
  // ?update=button / ?update=dialog: updater/current.json asks this version to update; otherwise the site's own file
  const ask = (/update=(button|dialog)/.exec(location.search) || [])[1];
  const newer = { web: 'v2026.10.12-000000', macos: 'v2026.10.12-000000', windows: 'v2026.10.12-000000', linux: 'v2026.10.12-000000' };
  const same = { web: 'v2026.10.11-000000', macos: 'v2026.10.11-000000', windows: 'v2026.10.11-000000', linux: 'v2026.10.11-000000' };
  const news = { 'v2026.10.10-000000': 'Older.', 'v2026.10.12-000000': 'Twelfth.\nSecond line.', 'v2026.10.11-def456': 'Same day.', 'v2026.10.14-000000': 'Fourteenth.' };
  const json = (o) => 'data:application/json,' + encodeURIComponent(JSON.stringify(o));
  const updates = ask && json({ 'show-update-button': ask ? newer : same, 'show-update-dialog': ask === 'dialog' ? newer : same });
  // ?version=v…: the build's version (default v2026.10.11-abc123)
  const appVersion = (/version=(v[0-9.]+-[0-9a-f]{6})/.exec(location.search) || [])[1] || 'v2026.10.11-abc123';
  window.__VO_HOST__ = Object.freeze({ platform: 'windows', version: 1, appVersion,
    updates: updates || '/updater/current.json', whatsnew: ask ? json(news) : '/updater/whatsnew.json' });
  window.__TAURI_INTERNALS__ = {
    async invoke(cmd, args) {
      log('hostCalls');
      if (cmd === 'host_launch_files') {
        const handles = later.splice(0);
        if (!sessionStorage.hostLaunched && !/nolaunch/.test(location.search)) {
          sessionStorage.hostLaunched = '1';
          handles.unshift(0);
        }
        return handles.map((handle) => ({ handle, name: files[handle].name }));
      }
      if (cmd === 'host_read') {
        if (!files[args.handle]) throw `no file with handle ${args.handle}`;
        return new TextEncoder().encode(files[args.handle].text).buffer;
      }
      if (cmd === 'host_open_url') {
        if (!/^(https?|mailto):/.test(args.url)) throw `not a web or mail address: ${args.url}`;
        sessionStorage.opened = args.url;
        return null;
      }
      if (cmd === 'host_ui_scale') return +(sessionStorage.uiScale || 1);
      if (cmd === 'host_set_ui_scale') {
        if (!(args.scale >= 0.5 && args.scale <= 4)) throw `UI scale ${args.scale} is outside 0.5..4`;
        sessionStorage.uiScale = String(args.scale);
        return null;
      }
      if (cmd === 'host_new_window') {   // this tab plays the new window
        if (new URL(args.url).origin !== location.origin) throw `not one of the app's pages: ${args.url}`;
        sessionStorage.newWindow = args.url;
        setTimeout(() => { location.href = args.url; });
        return null;
      }
      if (cmd === 'host_close_window') {   // app pages are app windows; the Start Center is "main"
        if (location.pathname === '/') return false;
        sessionStorage.closed = location.pathname;
        return true;
      }
      if (cmd === 'host_show_downloads') {   // takes nothing from the page
        sessionStorage.browsed = JSON.stringify(args === undefined ? null : args);
        return null;
      }
      throw `command ${cmd} not found`;
    },
  };
  if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { log('swRegister'); throw new Error('stub'); };
})();
