# Desktop app: save to real files, with a hardened host interface

Status: planned and approved (2026-10-11), not started. Builds on commit 32d7b2f (desktop app, `VO.host`); read
docs/desktop.md (Host interface, Versions and updates) first.

## Context

The desktop app (desktop/, Tauri) saves by downloading: every save in all three apps goes through
`L.saveFile(name, blob)` (public/common/core.js:241), which clicks a download link, and opening goes through
`L.pickFiles` (core.js:249), an `<input type=file>` that gives a copy with no path. The user wants Save to write the
real file, and wants the write path treated as the dangerous attack surface it is:

- each window keeps track of the files the **user really chose** (system Open/Save dialog, or the OS: Open with,
  double-click);
- **Save without a prompt** (Ctrl+S) may only write to the document's own chosen file — never anywhere else;
- **Save As and every export** (PDF, PNG, web page, CSV, …) always ask with the **system** Save dialog, and that write
  may only touch the file picked there; on the desktop the system dialog replaces the apps' Office-style Save As
  dialog (the web keeps it);
- when a write is refused for lack of permission (macOS App Store sandbox, Flatpak/Snap), say so and offer to grant
  access to the folder (a folder chooser) or to Save As elsewhere.

Threat model: the pages are our own code, but they parse untrusted documents; a parser bug that lets a document run
script must not turn into "write any file". So every guarantee lives in Rust; the page can only *ask*, by token, and
the native side checks.

## Native side (desktop/src/files.rs, new; host.rs keeps the IPC commands)

**Grants**, kept per window in `Host`: `token -> Grant { path (canonical, at grant time), window label, kind, ext,
last_seen (mtime, len) }`.
- Token: 128 random bits (hex) from the OS RNG (`getrandom`, already in the tree), never a counter; unknown,
  foreign-window or released tokens all fail the same way.
- `kind = Document`: from the system Open dialog, the OS command line, or a Save As dialog; readable, and writable by
  `host_save` only. `kind = ReadOnly`: pictures and other inserts picked with the Open dialog.
- A grant belongs to one window; `host_new_window(url, { grants })` *moves* named grants from the calling window to
  the new one (the Start Center hands a launched file to its app window). Closing a window drops its grants
  (`on_window_event` Destroyed). `host_release(token)` when a document closes.

**Commands** (replacing `host_launch_files`/`host_read` token types; all async where they show UI):
| Command | Does |
|---|---|
| `host_launch_files()` | files from the OS, once, as Document grants of the calling window → `[{ token, name }]` |
| `host_open_dialog({ filters, multiple, purpose: 'document'\|'insert' })` | system Open dialog (filters validated against the allow-list) → grants |
| `host_read(token)` | bytes of a granted file (size cap 512 MB) |
| `host_save(token, bytes, { overwriteChanged })` | write in place: Document grant of *this* window only |
| `host_save_as({ name, filters, bind }, bytes)` | system Save dialog (OS asks before replacing), then write there; `bind: true` (Save As) returns a new Document grant `{ token, name }`, `bind: false` (export) returns only `{ name }`; null if cancelled |
| `host_allow_folder(token)` | sandboxed builds only: folder chooser opened at the file's folder; succeeds only if the chosen folder contains the granted file (then the sandbox lets us write it) |
| `host_release(token)` | forget a grant |

**Every write** (`files::write_atomic`), whichever command:
- extension allow-list = what the apps write (docx docm dotx dotm rtf htm html txt md zip xlsx xlsm xltx xltm csv tsv
  prn xml pptx pptm ppsx ppsm potx potm pdf png); `host_save` additionally only to the grant's own extension;
- size cap 512 MB; target must still be a regular file or absent (no directory, device, or symlink swapped in since
  the grant: `symlink_metadata` check);
- changed on disk since we read/last wrote it (mtime or length) → `Err(changed)` unless `overwriteChanged`;
- write to a new temp file in the same folder (`create_new`, random hidden name), `sync_all`, then rename over the
  target (`MoveFileExW` REPLACE_EXISTING on Windows via `std::fs::rename`); on any error the temp file is removed and
  the original is untouched;
- errors as codes the page can act on: `denied` (PermissionDenied / read-only), `changed`, `missing`, `too-large`,
  `type`, `io` (+ message). No paths come *from* the page anywhere.

**Dialogs**: the `rfd` crate directly (not tauri-plugin-dialog/fs, which would expose generic file APIs to page
script): Windows via `IFileDialog` (`common-controls-v6`), Linux `gtk3` feature (GTK is already linked; no
wayland/portal extra), parented to the calling window. `__VO_HOST__` gains `sandboxed` (Flatpak `FLATPAK_ID`, Snap
`SNAP`, macOS `APP_SANDBOX_CONTAINER_ID`).

**CSP** (tauri.conf.json, from `null`): `default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:;
font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost
https://vibeoffice.work data:; script-src 'self'` (+ the hashes Tauri adds for inline scripts) — so a document cannot
pull script from anywhere. Checked on all three apps; if a page needs more (e.g. blob: workers), widen only that.

## Page side

**public/common/suite.js, `VO.host`** (web keeps today's behaviour):
- `pickFiles(accept, multiple, purpose)` → desktop: `host_open_dialog`, Files tagged with their token in a
  `WeakMap(file → token)`; web: `null` (callers fall back to `<input>`).
- `VO.opened(file, doc)` binds `doc → token` (`WeakMap`) when the file came with one (launch, Open dialog, handoff);
  `VO.saved` keeps it; `VO.discard`/close → `host_release`.
- Handoff: `VO.handoff` stores the token in the IndexedDB record; `VO.go` passes it to `newWindow(url, { grants })`;
  `VO.attach` re-tags the File, so a launched .docx can be saved back from its app window.
- `VO.host.save(doc, name, blob, intent)` — the one place apps' writes go on the desktop:
  - `'save'`: doc has a token → `host_save`; no token (new, dropped, Recent copy) → same as `'saveAs'`;
  - `'saveAs'` → `host_save_as(bind: true)`, then bind the doc to the new token;
  - `'export'` → `host_save_as(bind: false)`;
  - `changed` → app dialog "changed by another program since you opened it: Replace it / Save As… / Cancel";
  - `denied` → app dialog "VibeOffice can't save to <name>: it may not write in that folder" with **Allow access to
    folder…** (sandboxed builds) → `host_allow_folder` then retry, **Save As…**, Cancel.
  - resolves `{ status: 'saved' | 'cancelled', name }` (the name the user picked may differ).

**public/common/core.js**: `L.saveFile(name, blob, opts)` → on the desktop `VO.host.save(opts.doc, name, blob,
opts.intent || 'export')` (default is the safe one: always ask); returns `'saved'`/`'cancelled'` as now and puts the
chosen name in `opts.savedAs`. `L.pickFiles(accept, multiple)` → desktop Open dialog (purpose from `accept`).

**Apps** (small, at the call sites the exploration found; the system dialog replaces the in-app Save As on desktop):
- Quire app.js: `A.save` → `exportAs(type, name, 'save')`; `A.saveAs` on desktop skips `L.dlg.saveAs` and calls
  `exportAs` with intent `'saveAs'` and the type from the chosen extension (md vs zip → mdzip); exportAs passes
  `{ doc: d, intent }` and uses `opts.savedAs` for `A.fileName`; PDF/print/mail-merge stay `'export'` (default).
- Ledger app.js: same for `A.save`/`A.saveAs`; await the Save As dialog (fixes the found bug: Cancel while closing an
  untitled book closed it unsaved, dialogs.js:659 / app.js:101).
- Lectern app.js: same for `A.save`/`A.saveAs`/`exportAs`.
- The type lists for the system dialog's filters come from each app's existing Save As type list.
- Opens that skip `VO.opened` (Quire `openBytes`, Ledger `openHTML`, Lectern .txt) stay unbound: Save asks.

## Files

- desktop/src/files.rs (new: grants, allow-list, atomic write, dialogs), desktop/src/host.rs, desktop/src/main.rs
  (window-destroyed cleanup), desktop/Cargo.toml (`rfd`), desktop/tauri.conf.json (CSP)
- public/common/suite.js, public/common/core.js
- public/quire/js/app.js, public/ledger/js/app.js (+ dialogs.js Save As await), public/lectern/js/app.js
- tests/desktop/host-stub.js, tests/desktop/host.test.mjs; desktop/src/files.rs unit tests
- docs/desktop.md (host commands, the write rules, threat model), docs/suite.md; other sessions' in-progress app
  files: stage only these hunks when committing.

## Verification

1. `cargo test` (Linux, as the Linux build): files.rs unit tests — token scoping (other window, released, forged),
   extension rules, `host_save` refuses another extension, size cap, symlink/directory swapped in, changed-on-disk,
   atomic write leaves the original intact when the write fails (read-only folder), temp file cleaned up.
   Each fails on the previous code where it applies.
2. `node --test tests/desktop/host.test.mjs` with the stub extended to the new commands: Ctrl+S on a launched file →
   `host_save` with that file's token; Save As/export → `host_save_as` (bind vs not); `changed` and `denied` dialogs
   and their buttons; web path unchanged (download).
3. Linux live (display :0, offline, scratch files in ./tmp): launch with a .docx/.xlsx/.pptx made by the apps → edit →
   Ctrl+S writes it in place (bytes change, no dialog); Save As and PDF export show the GTK dialog; `chmod a-w` the
   folder → denied dialog; edit the file from a shell → changed dialog.
4. All four pages load with no console errors or external requests under the new CSP; tests/looks, ribbon, search
   still pass; Windows exe and MSI build; on Windows (user): Open with → edit → Ctrl+S, Save As, export PDF.

## Working notes for whoever picks this up

- Interim in place (replace it): saves are downloads into the Downloads folder, steered natively
  (`on_download` in desktop/src/main.rs, `host::download_destination`, `Host::downloaded`, `host_show_downloads`),
  and the app shows "Saved to Downloads folder: <name>" with Browse (`vo-download` listener in suite.js,
  `ui.toast(text, ms, action)`); docs/desktop.md, Saving (for now). With real saving, keep the download path only for
  what still downloads (the web), or drop it, and keep its rules (own blob:/data: only, SAVE_TYPES, no overwrite).

- Today: `desktop/src/host.rs` has `host_launch_files`/`host_read` with sequential numeric handles
  (`Host.files: Vec<PathBuf>`), process-wide, no window scoping; `host_new_window` (async; label `doc-N`),
  `host_close_window`, `host_open_url`, UI scale, `settings.json`. `desktop/src/main.rs` `open_window` builds every
  window with the same hooks. Replace the numeric handles with the token grants above.
- Page side today: `VO.host` in public/common/suite.js (section "the host"); `VO.handoff`, `VO.attach`, `VO.opened`,
  `VO.saved` (Recent Files identity: `docKeys` WeakMap). Start Center: public/index.html (`VO.host.onFiles`).
- Call sites (from the exploration): Quire app.js `A.save` ~785, `A.saveAs` ~789, `exportAs` ~810/841 (`'saved'`
  branch ~843), dialogs3.js `L.dlg.saveAs` ~730, PDF/print/mail merge (app.js ~906, dialogs3.js ~708/725,
  mailmerge.js ~261); Ledger app.js `A.save` ~231, `A.saveAs` ~238/262 (branch ~265), dialogs.js `D.saveAs` ~659
  (not awaited), `closeWorkbook` ~95/101 (the Cancel bug), print.js ~343; Lectern app.js `A.save` ~428, `A.saveAs`
  ~432, `exportAs` ~455 (branch ~457), dialogs.js `L.dlg.saveAs` ~907, `previewPDF` ~546. Line numbers drift; search
  for the names.
- Build: `desktop/build.sh` (Windows exe, zip, MSI; needs mingw-w64, `wixl`, `zip`). Linux:
  `cd desktop && cargo build --release --target x86_64-unknown-linux-gnu` (needs `libwebkit2gtk-4.1-dev`,
  `libgtk-3-dev`, `libsoup-3.0-dev`; on this machine without root they were unpacked into ./tmp/linuxdev/root and used
  via `PKG_CONFIG_SYSROOT_DIR`/`PKG_CONFIG_PATH`; `wixl` via ./tmp/msitools/root). `cargo test` builds the same way.
- Run the Linux build offline on display :0 with a scratch profile: `unshare -rn` and `XDG_DATA_HOME`/
  `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` under ./tmp (see ./tmp/run-linux.sh if it still exists). `xdotool` and `import`
  drive and screenshot it; the window position `xdotool getwindowgeometry` reports is off, take a root screenshot
  to find coordinates. Kill test instances with `pkill -f "unknown-linux-gnu/releas[e]/vibeoffice"`.
- Page tests: `node --test tests/desktop/host.test.mjs` (Chromium with CDP on 127.0.0.1:9222; `tools/shot.mjs --pre`
  runs `tests/desktop/host-stub.js` before each page; the stub must clean up any Recent Files entry a test adds).
- The page side changes `public/common/` (all three apps): load each app and screenshot what changes; other sessions
  edit the app files, so commit only your hunks.
- Not in scope: macOS build (the design keeps `sandboxed`/`host_allow_folder` for it), persisting grants across
  restarts (Recent Files reopen a stored copy; Save then asks), single instance.
