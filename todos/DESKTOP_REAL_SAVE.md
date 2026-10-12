# Desktop app: hardening, native storage, one document per window, real saving

Status: planned 2026-10-11, not started. Read docs/desktop.md (Host interface) first. Four phases, in order:
0 harden the host as it is (from the audit below), 1 native storage and one document per window (saves still go to
Downloads), 2 saving to real files, 3 folder access in sandboxed builds. Mark each task when it is done and verified.

## Tasks

Phase 0: harden the host as it is
- [ ] Capabilities: drop `core:default`; declare the `host_*` commands in an app manifest and grant them per window kind;
      window labels `<page>-<n>`
- [ ] Links: one `links::open` for `host_open_url`, `on_navigation` and `on_new_window`: the Start Center only, https,
      the allow-list; no mailto
- [ ] Links in documents (Quire, Ledger, Lectern) and on the licenses page: show the address with Copy on the desktop;
      on the web, only http(s) and mailto
- [ ] `on_new_window`: always Deny
- [ ] Navigation: a window loads only its own page, once
- [ ] CSP (tauri.conf.json) and no WebRTC
- [ ] `host_new_window`: page ids instead of URLs; at most 64 windows
- [ ] Launch files: `host_launch_files` and `host_read` for the Start Center only; reads capped at 512 MiB
- [ ] Downloads (interim): refuse Windows reserved names and trailing dots or spaces; at most one per window per second
- [ ] Web permission requests denied natively, except Local Font Access and the clipboard
- [ ] WebView2 browser shortcuts off
- [ ] Init script built with serde_json; `__VO_HOST__` read-only
- [x] Portable zip and DLL planting (audit item 15): the zip is released as `VibeOffice-<version>-x64-Portable.zip`,
      the exe inside its own `VibeOffice` folder; the release notes say to run it from there (2026-10-11)
- [ ] Tests (cargo, host stub, live link checks) and docs/desktop.md

Phase 1: native storage and one document per window
- [ ] Single instance (Unix socket, Windows named pipe)
- [ ] `~/.vibeoffice` store: config.json, recent_files, drafts, the atomic write, `VIBEOFFICE_HOME`
- [ ] Settings: `__VO_HOST__.settings`, `host_set_setting`, `vo-settings`; `VO.settings`, `L.store`, looks, the head
      scripts, UI size
- [ ] No browser storage: the init script removes the APIs, incognito web views, the static test; https scheme on Windows
- [ ] Files bound to windows: `host_document`, `host_open` with the Open dialog (rfd on Windows, the GTK adapter), files
      from the command line opened by Rust
- [ ] One document per window in Quire and Ledger; page-made documents as bytes; the Window menu
- [ ] Recent Files, previews and drafts native (`VO.recent` backend, Document Recovery)
- [ ] Close flow (`vo-close`)
- [ ] Scout to `VO.settings`
- [ ] Tests and docs

Phase 2: saving to real files
- [ ] File type table (types.rs)
- [ ] `files::write`: checks, temp file and replace, the in-place path, error codes
- [ ] `host_save`, `host_choose`, `host_write_chosen`, `host_cancel_choice`; the Save dialog
- [ ] Mark of the Web carried to Save As and exports (Windows)
- [ ] Previous versions and File ▸ Versions…
- [ ] `L.file` in common/core.js
- [ ] Quire, Ledger and Lectern on `L.file` (and Ledger's Cancel-while-closing fix)
- [ ] Remove the Downloads interim; File System Access API off
- [ ] Tests and docs

Phase 3: sandboxed builds
- [ ] Allow Access… for `denied` in Flatpak, Snap and the macOS App Store

## Decisions (the user, 2026-10-11)

- The desktop app never uses the web view's storage: no localStorage, sessionStorage, IndexedDB, Cache Storage or
  BroadcastChannel. The web keeps them.
- Settings: a host settings API, stored in `~/.vibeoffice/config.json`.
- Recent Files: `~/.vibeoffice/recent_files/<yyyy-mm>/<sha256>.recent`, the preview image beside it as
  `<sha256>.recent.preview`. A user's file name never comes into a path the app makes.
- Writing files is the dangerous surface. Save without a prompt (Ctrl+S) writes only the document's own file, which
  the user chose; Save As and every export always ask with the system Save dialog and write only what was picked
  there; no write ever goes to a path that came from a page.
- Only the Start Center opens web addresses, and only those on an allow-list kept in Rust.
- When a write is refused for lack of permission in a sandbox (macOS App Store, Flatpak, Snap), offer to grant access
  to the folder.
- Harden first, then native storage; real saving builds on both.

## Threat model

The pages are our code, but they parse untrusted documents: assume a document can run script in its window. Every
guarantee lives in Rust, keyed by the calling window, which Tauri hands to a command (`window: WebviewWindow`) from
the web view the call came from; a page can't name or pose as another window. The Start Center parses no documents,
so it is the one window trusted to open web addresses.

A compromised app window can: write its own document's file (its previous version is kept) and, once, a file the user
just picked in its Save dialog; write its own Recent Files entry's draft and preview, and the settings (bounded; Rust
acts on only two of them, validated); open Recent Files entries and page-made documents in new windows; remove Recent
Files entries and discard drafts of documents not open in any window.

It can't: write, read or name any other file; reach another window's document; take its file to another page; open
any address in the browser; send anything to a server other than vibeoffice.work (CSP); fill the disk (every stored
item has a size cap, and their number is bounded).

Accepted: the CSP is one policy for every page, so an app page may also reach vibeoffice.work, our own static site;
until Phase 1 moves the pages to https on Windows, Chromium may look up the names of links on the page (DNS prefetch),
a few bytes out; the page sets its window's title.

## Audit of the host as it is (545b9f7)

| # | Finding | Risk | Fix |
|---|---|---|---|
| 1 | `on_new_window` returns `Allow` for every address that isn't http(s): `file:`, UNC paths, `ftp:`, other apps' protocol handlers, our own pages. The engine then opens its own popup, outside all our handlers (navigation, downloads, the IPC rules), and what it does with those schemes is up to it. Document hyperlinks get there: Quire's Ctrl+click and Open Hyperlink and Lectern's slide show pass the document's address as it is; Ledger lets `ftp:` through | High | Phase 0: always Deny |
| 2 | `on_navigation` allows every address that isn't http(s), and any of our pages, in any window, any number of times | High | Phase 0: one page per window |
| 3 | The capability grants `core:default`: about 70 Tauri commands no page uses, among them `image.fromPath` (reads a file at a path the page gives), `path.resolveDirectory` and friends (the home folder, so the user's name), menus and tray icons, events to other windows, window, monitor and cursor queries | High (surface) | Phase 0: no core commands; ours per window kind |
| 4 | No CSP (`csp: null`): any page can fetch, post to or load from any server, so limiting links alone wouldn't stop a document's script from sending its text out | High | Phase 0: CSP |
| 5 | `host_open_url` and the external-link handlers: any window, any http(s) host, and `mailto:` (some mail programs honour `attach=` and attach local files) | Medium | Phase 0: Start Center, allow-list, no mailto |
| 6 | `host_read(handle)`: handles are process-wide, sequential and never revoked, so any window can read every file launched so far; no size cap | Medium | Phase 0: Start Center only, cap; Phase 1 replaces it |
| 7 | `host_launch_files`: any window can take the launch files | Low | Phase 0 |
| 8 | `host_new_window(url)`: any of our files, any query string, any number of windows | Medium | Phase 0: page ids, at most 64 |
| 9 | Downloads (interim): any page writes files into Downloads without asking, `.html` and macro-enabled `.docm`, `.xlsm`, `.pptm` included; Windows reserved names (`CON.docx`) and names ending in a dot or space aren't refused | Medium | Phase 0 for the names; Phase 2 ends downloads |
| 10 | A saved copy loses the Mark of the Web: a file from the internet saved under a new name no longer opens in Office's Protected View | Medium | Phase 2: carried over |
| 11 | WebRTC can reach any server; CSP doesn't cover it | Medium | Phase 0: removed by the init script |
| 12 | Web permission requests (camera, microphone, location, notifications) get the engine's default handling | Low, to verify | Phase 0: denied natively |
| 13 | WebView2's browser shortcuts are on: F5 and Ctrl+R reload, Ctrl+P, Ctrl+F, Ctrl+S (save the page) | Low | Phase 0: off |
| 14 | The init script is assembled with `format!`; a page can replace `__VO_HOST__` | Low (hygiene) | Phase 0 |
| 15 | The exe imports `dwmapi.dll`, which isn't a KnownDLL: the portable zip's exe run from Downloads, with a planted `dwmapi.dll` beside it, loads that DLL. The MSI installs into Program Files, which users can't write, so it is unaffected. GNU ld can't set `DependentLoadFlags` | Medium (zip) | Decided: released as the Portable zip, its exe inside a `VibeOffice` folder, so extracting it never puts the exe loose in Downloads; the release notes say to run it from that folder. The remaining risk (someone writing a DLL into that folder) is accepted |
| 16 | settings.json is written in place, not atomically | Low | Phase 1 store |
| 17 | The pages are served as http://tauri.localhost on Windows: not a secure context, and Chromium prefetches DNS for links on http pages | Low | Phase 1: https scheme (the origin change costs nothing once storage has left the web view) |

Checked and fine: devtools are off in release builds (no `devtools` feature); `withGlobalTauri` is off; IPC is
accepted only from our own origin (no remote URLs in any capability); opening an address hands only http(s) to the
system (`ShellExecuteW` "open", `xdg-open` with the address as one argument), never a path or a program; Browse takes
no arguments and shows only a file this app wrote into Downloads (explorer `/select` with a quoted path; Windows names
can't hold a quote); a download is a bare name of a type the apps save, never over an existing file; the save notice
carries the name only; the exe has NX, ASLR and high-entropy ASLR; the MSI installs per machine and its ProgIDs quote
`"%1"`; the updater's notes are shown as text, not HTML.

# Phase 0: harden the host as it is

None of this waits for native storage; it closes the audit's holes in today's build.

- **Capabilities.** Drop `core:default`: pages call only our `host_*` commands, through `__TAURI_INTERNALS__.invoke`.
  Declare those in an app manifest (build.rs: `tauri_build::try_build(Attributes::new().app_manifest(
  AppManifest::new().commands(&[…])))`), so each is refused unless a capability grants it, and grant them per window
  kind, which the label carries (`<page>-<n>`): `start` (`main`) its commands, `host_open_url` included; `apps`
  (`quire-*`, `ledger-*`, `lectern-*`) theirs, without `host_open_url`; `licenses-*` none. Each command still checks
  its window itself; the ACL is a second wall.
- **Links.** One function, `links::open(window, url)`, reached from `host_open_url` and from `on_navigation` and
  `on_new_window` when they meet an address outside the app. It opens the address only when:
  - the caller is the Start Center (label `main`, its page the Start Center's);
  - the address is https, on the default port, without a user name or password, and its host and path are on the
    allow-list, an exact host match and a path prefix that ends at a `/`:

    | Host | Path | For |
    |---|---|---|
    | `vibeoffice.work` | any | Update (`/updater/?from_version=…`), the site |
    | `github.com` | `/tcchen2026/VibeOffice` and below | the Start Center's GitHub button |

  It hands the system the address as the parser re-wrote it (`ShellExecuteW` "open", `xdg-open`). Everything else is
  refused, and `host_open_url` says so. No `mailto:`. The list is a constant in Rust: changing it is a release.
- **Links in documents.** On the desktop, Quire (editor.js Ctrl+click, app.js Open Hyperlink), Ledger (app.js
  HYPERLINK) and Lectern (slideshow.js `follow`) call one `VO.followLink(url)`, which shows the address instead of
  opening it: "VibeOffice doesn't open links from documents. The address is: …", with Copy Address and OK. Links
  inside the document (bookmarks, cells, slides) work as before. On the web `VO.followLink` opens a new tab, as today,
  but only for http(s) and mailto (Quire and Lectern pass any scheme today). The licenses page shows its addresses as
  text on the desktop.
- **New windows.** `on_new_window` always returns Deny: pages open windows only through `host_new_window`, and a
  `target=_blank` link that leaves the app goes to `links::open` first.
- **Navigation.** A window loads exactly one page, the one Rust opened it with: its first load passes, and so do
  fragment changes (the Start Center's `#create`); reloads, other pages and every other scheme (`file:`, `data:`,
  `blob:`, …) are refused; an address outside the app goes to `links::open`. Check on both platforms which
  same-document navigations reach `on_navigation`. This also keeps Phase 1's settings snapshot current.
- **CSP** (tauri.conf.json, now `null`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc:
  http://ipc.localhost blob: data: https://vibeoffice.work; frame-src 'none'; object-src 'none'; base-uri 'self';
  form-action 'none'`, with `dangerousDisableAssetCspModification: ["style-src"]` (Tauri adds hashes for inline
  styles, and a browser ignores `'unsafe-inline'` once a hash is there). `blob:` in connect-src because the pages
  `fetch` blob URLs; vibeoffice.work for the Start Center's update check. Tauri hashes the inline scripts (the head
  look script). The init script removes `RTCPeerConnection`, `webkitRTCPeerConnection` and `RTCDataChannel`, which the
  CSP doesn't cover. Check every page in the native build (the Chromium stub doesn't apply Tauri's CSP), and that eval,
  an injected inline script and a fetch to another host are blocked.
- **`host_new_window({ page, new, template })`**: `page` is one of `quire`, `ledger`, `lectern`, `licenses`; `template`
  matches `^[a-z0-9-]{1,40}$`; Rust builds the address. At most 64 windows are open; beyond that it refuses, and the
  page says so. Pages never open the Start Center.
- **Launch files**, until Phase 1 replaces them: `host_launch_files` and `host_read` only for the Start Center, which
  is the page that takes them today; `host_read` refuses files over 512 MiB and stops reading there.
- **Downloads (interim)**: refuse Windows reserved device names (CON, PRN, AUX, NUL, COM0–9 and LPT0–9, superscript
  digits too, with any extension) and names ending in a dot or a space; at most one download per window per second.
  The larger hole, that any page can drop files into Downloads unasked, closes with Phase 2.
- **Web permissions**: every permission request is denied natively except Local Font Access (Settings ▸ Fonts on
  this computer) and the clipboard (the apps' Paste). Windows: `PermissionRequested` on the web view (through
  `with_webview`; `webview2-com`, already built for Tauri, becomes a direct Windows dependency); Linux: WebKitGTK's
  `permission-request`. Check first what wry does by default on each.
- **WebView2 browser shortcuts** off (`AreBrowserAcceleratorKeysEnabled = false`, same route): no F5 or Ctrl+R reload,
  Ctrl+P print preview, Ctrl+F find bar, Ctrl+S page save. Check that editing keys (Ctrl+C, Ctrl+V, Ctrl+Z) and the
  apps' own shortcuts still work.
- **Init script**: built with `serde_json` (no string pasting); `__VO_HOST__` defined read-only and not configurable.
- **The Portable zip** (audit item 15), done: released as `VibeOffice-<version>-x64-Portable.zip` with its exe inside a
  `VibeOffice` folder; the release notes say to run it from there.

# Phase 1: native storage and one document per window

## The model

Today pages hold several documents and hand files to each other (Start Center → IndexedDB handoff → app window). On
the desktop:

- **A window is one page and one document.** Rust keeps, per window label: the document's file (if any) and its
  Recent Files key; Phase 2 adds the one destination the user just picked in its Save dialog. Labels are `<page>-<n>`
  from a counter and are never reused; a window's state goes when it is destroyed. A window loads one page only
  (Phase 0).
- **Only Rust gives a window its file.** Open with and double-click, the Start Center's Open File, File ▸ Open, Recent
  Files and Document Recovery all go to Rust, which opens a window with the file bound, or brings forward the window
  that already has it (same key). A page never passes a path; paths come out only for display (the folder of a Recent
  Files entry).
- **Documents a page makes** (mail merge's letters, …) go to a new, unbound window as bytes in the app's own format
  (`hooks.snapshot`). An unbound window has no file: its first Save asks.
- **Quire and Ledger** keep several documents per page on the web (`A.docs`, `A.books`, the Window menu). On the
  desktop the branch that adds a second document (Quire `A.loadDoc` with `newWindow`, Ledger `A.addBook`'s push) is
  never taken: New and templates open `new` / `template` windows (`VO.go`), files go through the native Open,
  page-made documents through the bytes handoff (call sites: Quire app.js `newDocument`, `openFile`, line ~771,
  mailmerge.js ~244; Ledger `newWorkbook`, app.js ~166/217, panes.js ~80/371). If the branch is reached anyway, log a
  console error so the tests catch a missed call site. The Window menu lists the app's windows (`host_windows`,
  `host_focus`). Lectern already has one presentation per page.
- **Closing.** Rust catches the close button (`CloseRequested`, prevent close) and tells the page (`vo-close`); the
  page runs its "Save changes?" flow for its one document and calls `host_close_window`. If the page doesn't answer in
  10 s, ask natively whether to close anyway (its draft is kept). This fixes today's gap: Tauri's close doesn't run
  `beforeunload`.
- **Single instance.** One process owns the windows, settings and Recent Files. A second launch passes its command
  line files to the first and exits; without files it brings up the Start Center (reopened if it was closed). Own small
  code rather than tauri-plugin-single-instance (which brings D-Bus on Linux): a Unix socket in `$XDG_RUNTIME_DIR`
  (else in `~/.vibeoffice`), on Windows a per-user named pipe that rejects remote clients. Only the same user reaches
  it, who could start the exe with those files anyway; it accepts paths of existing files only, treated exactly as the
  command line.
- The process ends with its last window; the Start Center ("main") may close while documents stay open.
- **https on Windows** (`use_https_scheme`): https://tauri.localhost, a secure context, no DNS prefetch for links.
  The origin changes, which costs nothing once no storage lives in the web view; update `links` and the CSP.

The app for a file comes from its extension: a Rust table equal to `VO.APPS` in public/common/suite.js (a unit test
reads suite.js and compares). An app's File ▸ Open offers that app's types; the Start Center offers all.

Dropped files: HTML5 drop gives bytes without a path, so a dropped document opens unbound (its first Save asks).
Later, perhaps: WebView2 can tell the path of a `File` the user dropped (`postMessageWithAdditionalObjects`); WebKitGTK
can't.

## Storage: ~/.vibeoffice

```
~/.vibeoffice/                      %USERPROFILE%\.vibeoffice on Windows; mode 0700 elsewhere
  config.json                       the settings
  recent_files/
    2026-10/                        the month (UTC) the entry was made; an entry never moves
      <sha256>.recent               the entry (JSON)
      <sha256>.recent.preview       its preview: JPEG, at most 320 px (VO.thumbnail) and 512 KB
      <sha256>.recent.draft         its unsaved changes in the app's own format, at most 50 MB; only while it has any
  previous_versions/                Phase 2
    2026-10/
      <sha256>.<unix ms>.previous   a version a save replaced
```

- **Keys.** A file's entry is the sha256 of its canonical path (`std::fs::canonicalize`; lower-cased on Windows, where
  names are case-insensitive), 64 hex digits: one file, one entry, and "is it open already?" is the same lookup. A
  never-saved document's entry is the sha256 of 32 random bytes. Under `recent_files/` only
  `<yyyy>-<mm>/<64 hex>.recent[.preview|.draft]` is read; anything else is ignored, and links are never followed.
- **The entry**: `{ "v": 1, "app": "quire", "path": "…" | null, "name": "Report.docx", "size", "mtime", "time",
  "draft": { "name", "time", "lossState" } | null }`; `size` and `mtime` are those of the version the window opened, so
  saving a recovered draft over a file changed since says so. The file name and path live only inside.
- **Pruning**, as the web's (`MAX_RECENT` 30): the 30 newest entries without a draft stay, entries with a draft are
  never pruned, an emptied month folder is removed. Settings ▸ Clear removes the entries without drafts.
- **config.json**: `{ "<key>": <JSON value> }` with the keys localStorage has today (`vibeoffice.look`,
  `vibeoffice.localFonts`, `vibeoffice.updateAsked`, `quire.autoText`, …), plus `vibeoffice.uiScale`, which replaces
  settings.json in the app config folder (read that once if config.json is missing). Keys match
  `^[a-z][a-z0-9]*\.[A-Za-z0-9_.-]{1,64}$`; a value is at most 1 MB, the file 8 MB. Rust acts only on
  `vibeoffice.uiScale` (0.5 to 4: the zoom of every window) and supplies `vibeoffice.look` = `paper` while it is unset;
  every other value is the pages' own data.
- One function writes every file here: a temp file in the same folder, `sync_all`, rename over the old one; a draft or
  preview before the entry that refers to it. config.json writes are coalesced (about 300 ms). Reading tolerates a
  missing or broken file (defaults; a broken entry is skipped).
- `VIBEOFFICE_HOME` overrides the folder, for tests.
- Nothing is migrated from the web view storage of the builds so far.

## Host interface (host::VERSION 2)

`window.__VO_HOST__`, set by the init script before the page's own: `{ platform, version, appVersion, settings }`,
`settings` being the config as it was when the window was made. Rust keeps every window's copy current
(`vo-settings`), and a window loads one page only, so the copy stays right.

Bytes cross as raw IPC bodies (Tauri's raw request and `ipc::Response`), small metadata as JSON or headers; never as
JSON arrays or base64. File IO runs off the UI thread. Every new command goes into the app manifest and the window
kinds' capabilities (Phase 0).

| Command | Does |
|---|---|
| `host_set_setting(key, value)` | stores it (null removes it); the other windows get `vo-settings` `{ key, value }` |
| `host_document()` | this window's starting document `{ name, saved, draft, lossState }` and `host_document_bytes()`, or null (blank, template) |
| `host_open({ here })` | system Open dialog; each file opens in a window of its own, or its window comes forward. `here` (the page is an untouched blank): the first file binds to this window and the page calls `host_document()` |
| `host_new_window({ page, new, template }, bytes?, name?)` | Phase 0's command; with bytes, a page-made document, unbound |
| `host_recent()` | `[{ key, app, name, folder, time, size, preview, draft: { name, time } \| null, open }]`, newest first |
| `host_recent_preview(key)` | the preview's bytes |
| `host_open_recent(key, draft)` | the entry (its unsaved version when `draft`) in a window of its own, or that window forward; a file's draft opens bound to the file |
| `host_recent_remove(key)`, `host_recent_clear()` | forget entries; refused for a document open in a window |
| `host_set_preview(jpeg)`, `host_set_draft(bytes, { name, draftName, lossState })`, `host_clear_draft()` | this window's entry only; an unbound window gets a random key with its first draft |
| `host_discard_draft(key)` | Document Recovery's Discard; refused for a document open in a window |
| `host_windows()`, `host_focus(id)` | the Window menu |
| `host_close_window()` | after `vo-close`, or File ▸ Exit |
| `host_open_url(url)` | Phase 0's rules (the Start Center only) |
| `host_show_downloads()` | as now, until Phase 2 |

Events into the pages, as `vo-download` today (Rust evaluates a `CustomEvent` on `window`): `vo-settings`,
`vo-recent` (the list changed), `vo-close`. Gone: `host_launch_files` and `host_read` with their process-wide
handles, `host_ui_scale` and `host_set_ui_scale` (now a setting).

**The Open dialog** (and Phase 2's Save dialog): Windows `rfd` (`IFileDialog`, `common-controls-v6`); Linux a small
`GtkFileChooserNative` adapter on Tauri's GTK thread, parented to `window.gtk_window()`, completing on its response
signal. rfd 0.17's GTK backend can't be used: it makes an unparented chooser on its own GTK thread and returns only a
path (its `set_parent` works for the XDG backend, not GTK). So `rfd` becomes a Windows-only dependency. GTK's native
chooser uses the portals inside Flatpak by itself. No tauri-plugin-dialog or -fs: they would hand page script generic
file APIs.

## Pages

- **No browser storage on the desktop**, enforced three ways:
  1. the init script removes `localStorage`, `sessionStorage`, `indexedDB`, `caches`, `BroadcastChannel`,
     `navigator.storage` and `navigator.serviceWorker` (getters that throw), so a use fails at once instead of quietly
     working;
  2. web views are made with `incognito(true)` (WebView2 InPrivate, WebKitGTK ephemeral; in wry 0.57), so whatever
     slips through is gone at exit;
  3. tests: the host stub removes the same APIs and every page loads and works without console errors; a static test
     allows those names only in the web branches of common/suite.js and common/core.js.
- `VO.settings` (suite.js): `get(key, default)`, `set(key, value)`, `remove(key)`, change events. Web: localStorage and
  its `storage` event; desktop: `__VO_HOST__.settings`, `host_set_setting`, `vo-settings`. Everything goes through it:
  `L.store` (core.js, keys `<APP_ID>.<name>`; its ~100 call sites stay as they are), looks, local fonts,
  `updateAsked` (index.html), the UI size (Settings).
- The head script that sets `data-look` before the first paint reads `__VO_HOST__.settings['vibeoffice.look']` when
  there is one: public/index.html, quire/ and lectern/index.html, tools/ledger/build/template.html (Ledger's page is
  generated: run make.py), the template in tools/oss-licenses.py (run it). Remove the localStorage seed in
  `host::init_script`.
- `VO.recent` keeps its shape for the Start Center, File menus, task panes and Document Recovery, with a desktop
  backend: the list from `host_recent`, previews through a new `VO.recent.preview(entry)` → Blob (web: `entry.thumb`),
  changes from `vo-recent` instead of BroadcastChannel. `setDraft`, `setThumb` and `discardDraft` map to the
  window-scoped commands; on the desktop `VO.opened` records only the preview (Rust recorded the opening when it bound
  the window); `VO.saved` clears the draft. `prune` and `keepData` are web only.
- `VO.attach` on the desktop opens what `host_document()` gives instead of `VO.launch` `open`/`recent`. `VO.handoff`
  (the Start Center's drop) → `host_new_window` with the bytes; the Start Center's Open File → `host_open`;
  `VO.host.onFiles` goes (Rust opens launched files itself).
- Until Phase 2, saves go to the Downloads folder as now; Rust also adds each file written there to Recent Files.
- Scout (common/scout/assistant.js) uses localStorage directly: move it to `VO.settings` or `L.store`.

# Phase 2: saving to real files

## What the user gets

- **Save (Ctrl+S)** writes the document's own file in place, without a prompt, as Office does. The title bar shows the
  file's name.
- **Save As and every export** (PDF, PNG, web page, CSV, …) show the system Save dialog, starting in the document's
  folder, with the app's types; the system asks before replacing a file.
- A file that is read-only, or in a format the app can't write (.doc, .xls, .ppt), opens normally; Save goes to Save
  As, the name filled in.
- The file on disk changes only when the user saves. Unsaved work lives in the drafts, never in the file.
- When a save fails, the user is told why in plain words, offered the next step (Replace It, Try Again, Save As…), and
  told their file hasn't changed, which is always true: a failed save leaves the original untouched.
- The version a save replaced is kept for a while, and File ▸ Versions… opens it (proposed; see Previous versions).
- Closing a window with unsaved changes asks first (Phase 1's close flow); the window closes only after a save that
  really happened.

## Rules

1. **Two ways a user's file gets written**, both keyed by the calling window: the window's own bound file, or the one
   destination the user just picked in that window's Save dialog. Nothing else writes a user's file.
2. **A page never passes a path, a folder or an extension pattern.** It says what it wants (save, save as, export), a
   type from a fixed table, a suggested bare name, and the bytes. Rust picks folders, builds the dialog's filters from
   its own table and checks every write against it.
3. **One write function** for every write: the checks, a safe replace, the previous version kept.
4. **Every other way out is closed** on the desktop: web view downloads are refused, and the File System Access API
   (`showSaveFilePicker`, `showOpenFilePicker`, `showDirectoryPicker`; WebView2 has it, the pages don't use it) is
   removed by the init script.
5. **One save at a time per window**, a path bound to at most one window, and writes to one path never overlap.

## Native side

### Per window (adds to Phase 1's state)

- `file`: `{ path, type, base, read_only }`, where `base` is `(size, mtime, file id)` of the version this window read or
  last wrote (file index on Windows, inode elsewhere).
- `choice`: `{ path, type, purpose: saveAs | export, existed: base or none }`: the destination picked in this window's
  Save dialog. Dropped by its successful write, a newer choice, `host_cancel_choice` or the window closing; kept after
  a failed write, so Try Again works.
- `kept`: whether this window already kept the previous version of its file.
- The window's app comes from its label (`quire-*`, `ledger-*`, `lectern-*`); it limits the types.

### File types: one table (desktop/src/types.rs)

Each row: id, extensions, the dialog's label (Office's names), app, whether a Save As to it binds the window (types the
app opens and writes as a document), and how the bytes must start:

| App | Types |
|---|---|
| Quire | docx, docm, dotx, dotm (zip, or OLE when encrypted), rtf (`{\rtf`), htm/html, txt, md (text), mdzip as .zip (zip), pdf (`%PDF-`) |
| Ledger | xlsx, xlsm, xltx, xltm (zip or OLE), csv, tsv, prn, xmlss as .xml, htm/html (text), pdf |
| Lectern | pptx, pptm, ppsx, ppsm, potx, potm (zip or OLE), pdf, png (PNG signature), htm/html |

It replaces `SAVE_TYPES` in host.rs. The byte check guards against a writer mix-up (.md bytes under .zip); it is not
the security boundary. Reading has its own list (`VO.APPS`, Phase 1), so a readable format never becomes writable by
accident. A node test keeps each app's type descriptors (below) and this table in step.

### Commands (host::VERSION 3)

Bytes cross as raw IPC bodies, options in headers; the commands go to the `apps` capability only.

| Command | Does |
|---|---|
| `host_save(bytes, { replace })` | writes this window's `file`; `replace` only after the user answered `changed` with Replace It |
| `host_choose({ purpose, types, type, name })` | system Save dialog: filters from the table (`types` must belong to the window's app), `type` preselected, `name` a bare file name (no separators, `..`, drive or UNC prefix, stream, NUL, reserved name), the folder the file's own (else the last one used in this window, else Documents). Stores the `choice`; returns `{ name, type }`, or null when cancelled |
| `host_write_chosen(bytes)` | writes the `choice`; a Save As to a binding type makes it the window's `file` (and its Recent Files entry: a never-saved document's random entry moves to the file's key, the preview with it). Returns `{ name, type, bound }` |
| `host_cancel_choice()` | the page gave up after choosing (the compatibility check's Cancel) |
| `host_versions()` | the kept previous versions of this window's file: `[{ id, time, size }]` |
| `host_open_version(id)` | one of them in a new, unbound window |

`host_document()` also returns `{ type, readOnly }`.

Errors are codes the page acts on, each with a message that names the file but holds no path:

| Code | When |
|---|---|
| `changed` | the file differs from `base` (another program saved it) |
| `missing` | the bound file is gone (moved, renamed, deleted); never recreated silently |
| `denied` | no permission, or the file is read-only (even when its folder is writable) |
| `busy` | another program holds the file (a sharing violation), after a few quick retries for virus scanners |
| `full` | the disk is full |
| `open-elsewhere` | Save As chose a file that another window has open |
| `too-large` | over 512 MiB |
| `type` | the extension, type or start of the bytes doesn't match the table |
| `io` | anything else, with the system's message |

### The write (desktop/src/files.rs)

1. Check: a target exists for this window (`file` or `choice`); the type is the window's app's and matches the path's
   extension; at most 512 MiB; the bytes start as the type says; the target is a regular file (`symlink_metadata`: a
   link, directory or device in its place is refused), or absent when the dialog picked a new name; for `file`,
   unchanged since `base` unless `replace`.
2. Keep the previous version, if the target exists and this window hasn't kept one yet (below).
3. Write a temp file in the target's folder, `.~vibeoffice-<16 random hex>.tmp` (hidden on Windows; no user file name
   in it), `create_new`, write, `sync_all`.
4. Replace: `ReplaceFileW` on Windows (keeps the file's ACL, attributes and streams, its Mark of the Web among them),
   `MoveFileExW` for a new file; elsewhere copy the mode onto the temp, `rename`, then sync the folder. Verbatim
   (`\\?\`) paths on Windows, so long paths work.
5. When a replace would lose something (Unix: a folder we can't write in, a file with other hard links or another
   owner), write in place instead: truncate, write, sync, and on failure put the kept previous version back.
6. **Mark of the Web** (Windows): when the window's file came from the internet (it has a `Zone.Identifier` stream),
   a Save As or an export writes the same stream onto the new file, so Office still opens the copy in Protected View.
   A never-saved document made from such a file carries it too.
7. On any failure before the replace: remove the temp; the original is untouched. Once replaced, the save counts as
   done, even if the bookkeeping after it fails.
8. After success: `base` from the file as written; the Recent Files entry's time and size; the window's draft deleted
   (Rust does it, in the same step); `vo-recent` to the windows.

**The Save dialog**: Windows with `FOS_STRICTFILETYPES` and a default extension, the current type first. GTK Save
filters neither add extensions nor reject names, so the adapter reads the selected filter: an extension typed for
another allowed type switches to that type, a missing one gets the filter's, and the chooser confirms replacing the
exact final name before the choice is stored (show the final name if it changed). Never write a path other than the
one the dialog confirmed. A destination open in another window → `open-elsewhere`; the window's own file → a normal
save (the dialog already asked).

### Previous versions (proposed)

`~/.vibeoffice/previous_versions/<yyyy-mm>/<sha256 of the path>.<unix ms>.previous`: the version on disk before the
first write over it from a window (one per editing session, not per save), and before an export replaces an existing
file. Same naming rule as Recent Files: no user file name in the path. Kept 30 days, at most 5 per file and 1 GB in
all (oldest go first); files over 200 MB aren't kept. Pruned at start and after writes. Even a compromised page can't
destroy the one file it may write, and a bad save (a writer bug Office complains about) can be undone. File ▸
Versions… (desktop only; Paper 2016: File ▸ Info) lists them; Open shows one in a new window, from which the user
saves it where they like.

## Page side

### One API for all three apps: `L.file` (common/core.js)

```
L.file.setup({
  types,       // the app's Save As list, in order: [{ id, label, ext: ['docx'], document: true }, …]
  current,     // () => ({ doc, name, type, saved })
  prepare,     // async (doc, type, name) => { blob, losses } | { switchTo: 'mdzip' } | null (the user declined)
  saved,       // (doc, { name, type, blob, losses }) after a document save: the app's name, type, dirty state
  webSaveAs,   // (doc) => Promise<{ name, type } | null>: the app's own Save As dialog, web only
})
L.file.save()          // Ctrl+S, and Save in the "Save changes?" prompt  → 'saved' | 'cancelled'
L.file.saveAs()        // F12
L.file.export(type)    // PDF, PNG, CSV, web page, …
```

- **Desktop.** Save: bound, writable and the same type → `prepare` → `host_save`; otherwise Save As. Save As and export:
  `host_choose` → `prepare(type)` → `host_write_chosen` (`prepare` runs after the dialog because the chosen type picks
  the writer; null → `host_cancel_choice`; `switchTo` → the dialog again with the new type, name kept).
- **Web.** Save: `prepare` → download; Save As: `webSaveAs` → `prepare` → download; export: `prepare` → download. The
  same flow as today, through one place.
- Both: one save at a time per window (a queue); the document captured at the start and passed to every step; `saved`
  only after the write succeeded, and the dirty state cleared only if nothing changed meanwhile; exports never touch
  the document's name, type, entry or dirty state; compatibility losses acknowledged only on success; `vo-saved
  { name }` (Scout's Save act) only for `'saved'`. `L.saveFile` stays for odd callers, as an export.
- Errors become the app's own message box (`ui.msg`), with the file's name and the next step:

| Code | Says | Buttons |
|---|---|---|
| `changed` | “Report.docx” was changed by another program after you opened it. | Replace It, Save As…, Cancel |
| `missing` | “Report.docx” is no longer where it was: it was moved, renamed or deleted. | Save As… (its old folder and name), Cancel |
| `denied` | VibeOffice can't save “Report.docx”: it is read-only, or you don't have permission to change it. | Save As…, Cancel (Phase 3 adds Allow Access…) |
| `busy` | “Report.docx” is open in another program, which is keeping it from being changed. | Try Again, Save As…, Cancel |
| `full` | There isn't enough space on the disk to save “Report.docx”. | Save As…, Cancel |
| `open-elsewhere` | “Report.docx” is open in another VibeOffice window. Close it there, or choose another name. | OK (back to the dialog) |
| others | “Report.docx” couldn't be saved: (the message). | OK |

  Every message for a failure before the replace ends with "Your file hasn't changed."

### What each app does

- Turn the app's `save`, `saveAs` and `exportAs` into `L.file.setup` hooks; the type descriptors are its existing Save
  As list, shared by its web dialog and the desktop's filters (keep the aliases: `htm`/`html`, `xml` → `xmlss`, `zip` →
  `mdzip`). Keep each app's current rule on which types are a document save (Quire today: docx, docm, dotx, dotm, md,
  mdzip; html, rtf and txt are exports). Distinguish saving an opened CSV from exporting a workbook's active sheet.
- **Quire** (app.js `A.save`, `A.saveAs`, `A.exportAs`, dialogs3.js `L.dlg.saveAs`; PDF, print, mail merge): the
  Markdown pictures question returns `{ switchTo: 'mdzip' }` instead of changing `A.fileType` before the save succeeded;
  the compatibility check (`ui.compatibility`) stays inside `prepare`.
- **Ledger** (app.js `A.save`, `A.saveAs`, `closeWorkbook`; dialogs.js `D.saveAs`; commands.js; print.js): tell Save,
  Save As, Save as Web Page and Export CSV apart; await the real outcome (`D.saveAs` isn't awaited, and
  `ui.dialog().done` resolves Cancel as a truthy index, so Cancel while closing an untitled book closes it unsaved; fix
  that on the web too); PDF export reports its outcome; keep passwords and encryption.
- **Lectern** (app.js `A.save`, `A.saveAs`, `A.exportAs`, dialogs.js `L.dlg.saveAs`, `previewPDF`): the same.
- The desktop's title shows "(Read-Only)" for a read-only file; File ▸ Versions… in each app (and the ribbon's File
  tab).
- The refactor changes no writer: on the web, the bytes saved for the same input are identical before and after.

## Removing the interim

Rust refuses every web view download (`on_download` → false); `download_destination`, `Host::downloaded`,
`host_show_downloads`, the `vo-download` notice, Browse, and Phase 1's "add a Downloads save to Recent Files" go.

# Phase 3: sandboxed builds

Flatpak, Snap and the macOS App Store: `denied` offers Allow Access…: a folder chooser at the file's folder, then the
save again, only if the chosen folder holds the bound file (verify it is the same file; portal paths may differ).
`__VO_HOST__.sandboxed` (`FLATPAK_ID`, `SNAP`, `APP_SANDBOX_CONTAINER_ID`). Unsupported → say so and offer Save As.
Unverified until tried in those sandboxes; macOS builds are out of scope for now.

# Files

- Phase 0. desktop/src: main.rs (navigation, new windows, permissions, browser keys, downloads), host.rs (commands,
  init script), links.rs (new); build.rs (app manifest), capabilities/ (per window kind), tauri.conf.json (CSP);
  Cargo.toml (webview2-com on Windows), then tools/oss-licenses.py. public/common/suite.js (`VO.followLink`,
  `newWindow` by page id), the apps' hyperlink code, tools/oss-licenses.py's page (links as text on the desktop).
- Phase 1. desktop/src: main.rs (windows, close flow), host.rs (commands), store.rs (new: ~/.vibeoffice, config,
  Recent Files, drafts, the atomic write), instance.rs (new: single instance), the Open dialog (the GTK adapter);
  Cargo.toml and Cargo.lock (sha2, now a direct dependency; rfd Windows-only), then tools/oss-licenses.py.
  public/common/suite.js, core.js, public/index.html, the apps' head scripts and app.js (new document paths, Window
  menu), tools/ledger/build/ (then make.py), common/scout/assistant.js.
- Phase 2. desktop/src: types.rs and files.rs (new), host.rs (commands; the interim goes; File System Access API off),
  main.rs (`on_download`), store.rs (previous versions), the Save dialog. public/common/core.js (`L.file`),
  suite.js (the interim notice goes); the three apps' save code and Save As dialogs; menus and ribbons for
  Versions… (`node --test tests/ribbon.test.mjs`).
- Phase 3. The folder access in files.rs.
- Every phase: tests/desktop/host-stub.js, host.test.mjs, Rust unit tests; docs/desktop.md (host interface, the link
  rule, storage, threat model, the one-document rule, saving and its rules), docs/suite.md (Recent Files, settings,
  `L.file`), the app docs where links or saving change.

# Verification

1. `cargo test` (Linux target), each regression test failing on the code before its fix:
   - Phase 0: `links::open` refuses every window but the Start Center, http, other ports, a user name, lookalike
     hosts (`vibeoffice.work.example.com`, `xn--` forms, `github.com/tcchen2026/VibeOfficeX`) and every scheme but
     https, and hands over the re-written address; the navigation rule (first load, fragment, reload, another page,
     `file:`, `data:`, `blob:`, other schemes); `on_new_window` denies everything; `host_new_window` page ids,
     template ids and the 64-window cap; reserved and trailing-dot download names; the init script is valid JS for any
     version string.
   - Phase 1: keys (the same file by another name, a link or, on Windows, other case → one entry); a user's name never
     in a path (names with `..`, separators, Unicode: only hex under `recent_files/`); size caps; pruning keeps
     drafts; foreign and broken files ignored; the atomic write leaves the old file when it fails; setting keys and
     values validated; the extension table equals `VO.APPS`.
   - Phase 2: only the window's `file` or its one `choice` is written; a choice works once; another window's file is
     out of reach; export never binds; Save As binds and moves the Recent Files entry; another app's type, an
     extension that doesn't match, bytes that don't start right, over 512 MiB; a link, directory or device swapped
     in; a read-only file in a writable folder; missing; changed (and Replace); a destination open in another window;
     failures at create, write, sync and replace leave the original byte for byte and no temp file; the in-place path
     restores the previous version when it fails; permission tests run without privileges that bypass chmod; previous
     versions kept once per window, pruned by count, age and size, names only hex and digits; the Mark of the Web
     copied (Windows).
2. `node --test tests/desktop/host.test.mjs`, the stub speaking the new commands:
   - Phase 0: `VO.followLink` shows the address with Copy in the apps, opens nothing; the Start Center's GitHub and
     Update buttons call `host_open_url`; on the web, `javascript:` and `file:` links don't open.
   - Phase 1, with the storage APIs removed: every page loads without console errors; looks and settings change and
     reach the other windows; Recent Files, previews, drafts and Document Recovery work from the stub; the static
     storage test; the web path unchanged (tests/looks, ribbon, search).
   - Phase 2: Ctrl+S on a bound file → one `host_save`; unbound, read-only and .doc → Save As; Save As picks the type
     before `prepare`; Cancel at the dialog, at the compatibility check and in the Markdown question; every error
     code's message and buttons; Ledger's Cancel while closing keeps the book open; exports keep the dirty state; the
     web path still downloads the same bytes.
3. Linux live, offline (`unshare -rn`), on display :0, with `VIBEOFFICE_HOME` and scratch documents under ./tmp so the
   real ~/.vibeoffice is never touched:
   - Phase 0: a test document in each app with links to https, `file:///`, a UNC path, `ftp:`, `mailto:` and another
     protocol handler: Ctrl+click and the slide show open nothing, the address dialog appears; the GitHub button and
     Update open the browser (`xdg-open` logged, the network being off); a page calling `host_open_url` from an app
     window, a Tauri core command (`plugin:path|resolve_directory`) and `window.open` are refused; F5 does nothing;
     every page loads without CSP violations; a fetch to another host and WebRTC fail.
   - Phase 1: launch with a file → its app's window; the same file again → that window comes forward, another file →
     a new window in the same process; a setting changed in one window reaches another; `kill -9` with unsaved changes
     → the next start offers the draft; `find` over the home shows no user file names.
   - Phase 2: open → edit → Ctrl+S (bytes change, no dialog, the file reopens); Save As and PDF export through the GTK
     dialog, with type changes, no extension and an existing file; `chmod a-w` the file → denied; edit it from a
     shell → changed; remove it → missing; Versions… opens the version before the save. Each app's saved files open in
     LibreOffice.
4. Windows exe and MSI build. On Windows (the user): Phase 0: the link document as on Linux, F5, Ctrl+P and Ctrl+S
   do nothing the page didn't ask for, editing keys work, camera or location requests are denied; Phase 1:
   double-click the same .docx twice (one window), Recent Files, settings, closing with unsaved changes; Phase 2:
   Ctrl+S, Save As, PDF export, a file open in Word (busy), a read-only file, a downloaded file saved as a copy still
   opens in Protected View; the saved files open in Word, Excel and PowerPoint without a repair prompt.
5. Time a 30 MB workbook through `host_save` (IPC and write) and note peak memory.

# Working notes

- The code today (545b9f7): desktop/src/host.rs has `host_launch_files`/`host_read` with process-wide numeric handles
  (any window can take the launch files), `host_new_window` (async: creating a window from a sync command deadlocks on
  Windows; label `doc-N`; same scheme, host and port, because `Url::origin()` is opaque for tauri://),
  `host_close_window` (refuses "main"), `host_open_url` with `is_external`/`open_external`, UI scale in settings.json,
  the Downloads interim (`download_destination`, `downloaded`, `host_show_downloads`; docs/desktop.md, Saving (for
  now)). desktop/src/main.rs `open_window` builds every window with the same hooks (`on_navigation`, `on_new_window`,
  `on_download`, title, zoom set on each page load because WebKitGTK resets it). capabilities/default.json grants
  `core:default` to `main` and `doc-*`. Page side: `VO.host`, the IndexedDB section, `VO.recent`, `VO.handoff`,
  `VO.attach`, `VO.opened`, `VO.saved` in public/common/suite.js; `L.store`, `L.saveFile`, `L.pickFiles` in
  public/common/core.js; hyperlinks in quire/js/editor.js (~910) and app.js (~1010), ledger/js/app.js (~812),
  lectern/js/slideshow.js (`follow`).
- Commands that need the calling window take `window: WebviewWindow`; Tauri fills it in, the page can't.
- `NewWindowResponse::Allow` means the engine's own popup ("the default implementation"), not one of our windows.
- The exe's DLL imports (`x86_64-w64-mingw32-objdump -p`): advapi32, comctl32 (side by side, v6), dwmapi, gdi32, imm32,
  kernel32, msvcrt, ntdll, ole32, oleaut32, shell32, shlwapi, user32, bcryptprimitives, combase, two api-ms-win sets,
  WebView2Loader. DllCharacteristics 0x160 (NX, ASLR, high-entropy); no load configuration directory.
- desktop/Cargo.toml already has `rfd` 0.17 (gtk3 feature) from an earlier session, uncommitted at planning time: make it
  Windows-only (Phase 1, Open dialog).
- Build: `desktop/build.sh` (Windows exe, zip, MSI; needs mingw-w64, `wixl`, `zip`). Linux: `cd desktop && cargo build
  --release --target x86_64-unknown-linux-gnu` (needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`; on
  this machine without root they are unpacked in ./tmp/linuxdev/root, used with
  `PKG_CONFIG_SYSROOT_DIR=$PWD/tmp/linuxdev/root` and
  `PKG_CONFIG_PATH=$PWD/tmp/linuxdev/root/usr/lib/x86_64-linux-gnu/pkgconfig:$PWD/tmp/linuxdev/root/usr/share/pkgconfig`
  from the repository root). `cargo test` builds the same way. `wixl` 0.106: `tmp/msitools/root/usr/bin/wixl` with
  `LD_LIBRARY_PATH=$PWD/tmp/msitools/root/usr/lib/x86_64-linux-gnu`.
- Run the Linux build offline on display :0 with a scratch profile: `unshare -rn`, `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/
  `XDG_CACHE_HOME` (and `VIBEOFFICE_HOME`) under ./tmp. `xdotool` and `import` drive and screenshot it; the window
  position `xdotool getwindowgeometry` reports is off, take a root screenshot to find coordinates. Kill test instances
  with `pkill -f "unknown-linux-gnu/releas[e]/vibeoffice"`.
- Page tests: `node --test tests/desktop/host.test.mjs` (Chromium with CDP on 127.0.0.1:9222; `tools/shot.mjs --pre`
  runs `tests/desktop/host-stub.js` before each page; a test cleans up whatever it adds).
- Changes in public/common/ touch all three apps: load each and screenshot what changes. Refresh `git status` before
  starting and commit only this work's hunks.
