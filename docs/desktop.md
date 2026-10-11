# VibeOffice desktop app (Tauri): Windows first, Linux too

`desktop/` wraps the suite in `public/` in a native window with [Tauri 2](https://tauri.app). The pages are the same files as the web version, embedded in the binary (brotli) and served from `http://tauri.localhost/` (Windows) or `tauri://localhost/` (Linux). They draw in the system's web view: WebView2 (Edge) on Windows, which every supported Windows 10 and 11 already has; WebKitGTK 4.1 on Linux. The pages reach the system only through `VO.host` (Host interface below).

| File | What |
|---|---|
| `desktop/Cargo.toml` | the crate; size-tuned release profile (`opt-level = "z"`, LTO, one codegen unit, `panic = "abort"`, stripped); Tauri without `dynamic-acl` |
| `desktop/.cargo/config.toml` | builds for `x86_64-pc-windows-gnu` with mingw-w64 by default |
| `desktop/tauri.conf.json` | app name and identifier, `frontendDist: ../public`, `devUrl` (tools/serve.py), `removeUnusedCommands`; Tauri's bundler is off (the MSI is built by `build.sh`) |
| `desktop/src/main.rs` | the main window: system title bar follows `document.title`, file drops go to the page, links out of the app go to the default browser, the UI size on each page load, `__VO_HOST__` before each page |
| `desktop/src/host.rs` | the native side of `VO.host`: the `host_*` commands, file handles, `settings.json` |
| `desktop/capabilities/default.json` | `core:default` for the main window |
| `desktop/icons/` | `icon.ico` (16–256 px; exe, MSI, file types) and `icon.png` (128 px, Linux window icon; Tauri embeds it as raw RGBA, so keep it small) |
| `desktop/licenses/` | license texts of what ships with the app but is not a crate (`WebView2Loader.txt`, from the WebView2 SDK package), for `public/oss-licenses.html` |
| `desktop/vibeoffice.wxs` | the MSI: files, Start menu shortcut, file types, upgrades |
| `desktop/build.sh` | release build: exe, portable zip and MSI in `desktop/target/dist/` |
| `.github/workflows/windows.yml` | CI, run by hand: `build.sh` on Ubuntu; the MSI and zip as the run's artifact and a GitHub release |
| `tests/desktop/` | `host.test.mjs` and `host-stub.js` (Host interface, below) |

## Host interface

One interface between the pages and what runs them, so a page never asks which: `VO.host` in `public/common/suite.js`. In a browser (tab or installed PWA) it is built on the browser's APIs; in the desktop app on the commands in `desktop/src/host.rs`, called over Tauri's IPC (`window.__TAURI_INTERNALS__.invoke`). The desktop app announces itself before each page's scripts with `window.__VO_HOST__ = { platform, version, appVersion }`; the same script makes Paper the desktop app's look until the user picks one (`vibeoffice.look`).

| `VO.host` | Web | Desktop |
|---|---|---|
| `kind` | `'web'` | `'desktop'` |
| `platform` | `'web'` | `'windows'`, `'linux'` (Rust's `std::env::consts::OS`) |
| `version` | `0` | `host::VERSION`, raised when a command changes shape |
| `onFiles(fn)` | `launchQueue` (the PWA's file handlers) | `host_launch_files`, then `host_read` for each |
| `openUrl(url)` | a new tab | `host_open_url`: http, https and mailto only, to the system (`ShellExecuteW`, `xdg-open`) |
| `newWindow(url)` | `window.open` (false if blocked) | `host_new_window`: one of the app's own pages (same scheme, host and port) in a full window (`doc-N`) with the host script and handlers |
| `closeWindow()` | `false` | `host_close_window`: closes an app window (true); the Start Center's (`main`) stays (false) |
| `uiScale()`, `setUiScale(n)` | `null` (the browser's own zoom does it) | `host_ui_scale`, `host_set_ui_scale`: the web view's zoom, 0.5–4, every window, kept in `settings.json` |

`VO.VERSION` is `appVersion` in the desktop app (the build's version, below).

`fn(files)` gets `File` objects; the Start Center calls `onFiles` and opens the first file in its app (`VO.handoff`). The service worker is registered only on the web.

Links: besides `openUrl`, the native side sends every navigation or new window that leaves the app (http(s) to another host, mailto) to the default browser (`on_navigation`, `on_new_window` in `main.rs`): the Start Center's GitHub button and the `target="_blank"` links the apps open for hyperlinks need no change. The app's own pages (`tauri://localhost`, `http://tauri.localhost`; devUrl in a dev build), `blob:`, `data:` and `about:` stay in the app.

UI size (Settings on the Start Center): the web view's zoom, as Ctrl + in a browser, so canvases stay sharp and clicks land where they should. CSS `zoom` on the page was measured and does not work: at 200 % every click on Ledger's grid landed on B4 and menus opened at twice their place. `settings.json` (the app's config folder: `%APPDATA%\work.vibeoffice.desktop\`, `~/.config/work.vibeoffice.desktop/`) keeps it, and it is applied as each page starts loading (WebKitGTK resets the zoom on the first load).

Rules for growing it:

- Pages call `VO.host`, never Tauri, `launchQueue` or the File System Access API directly; both sides get each new method, the web side doing what the browser can (or reporting that it cannot).
- Files cross as handles: numbers the native side gives out for paths the user or the system chose (command line now; Open and Save dialogs next), never paths from the page, so a page reads and writes only what it was given.
- Commands are named `host_<verb>`, take named arguments and return JSON or raw bytes (`tauri::ipc::Response`, an `ArrayBuffer` in the page) for file contents.
- App commands are allowed only for the app's own pages: Tauri refuses them from any other origin while the app has no ACL manifest.

Windows: as when the PWA is installed, the Start Center stays in its window and each app opens in one of its own (`VO.go` → `newWindow`); a file the app was started with opens beside the Start Center. File ▸ Exit in an app window closes it (`VO.exit` → `closeWindow`). A page cannot simply `window.open`: WebView2 would make a bare popup without the host script or IPC, so the app's own new windows are made natively (`open_window` in `main.rs`, from an async command: a sync one deadlocks on Windows).

Planned: `open({ accept })` (the system's Open dialog), `save(handle, blob)` and `saveAs(name, blob)` (in place, as File ▸ Save does in Office) and `onFiles` for files opened while the app is running (single instance: today a second file starts a second process).

`node --test tests/desktop/host.test.mjs` checks the page side in Chromium: `tests/desktop/host-stub.js` plays the desktop host (run before each page with `tools/shot.mjs --pre`; `?nolaunch` and `?update=button|dialog` set the scene): a launch file opens in its app once, with no service worker and the build's version; `openUrl` refuses anything but web and mail addresses; Settings sets the UI size (the web points to the browser's zoom); the update policies; versions compare by date.

## Saving (for now)

Until the app writes real files (todos/DESKTOP_REAL_SAVE.md), a save is a download into the system's Downloads
folder, decided natively (`on_download` in `main.rs`, `host::download_destination`): only the pages' own `blob:` and
`data:` files, only the types the apps save (`SAVE_TYPES`: documents, workbooks, presentations, PDF, PNG, CSV, text,
web pages), always straight in Downloads under the bare file name, never over an existing file (`Budget (1).csv`).
When it is written, the native side tells that window the name the file got (`vo-download`; never a path), and the
app shows *Saved to Downloads folder: <name>* with **Browse** (`ui.toast` with an action). Browse is
`host_show_downloads()`: no arguments; it opens the Downloads folder and, on Windows, selects the file this window
last saved (`explorer /select`), the one the native side wrote.

## Versions and updates

A version is `v<yyyy>.<mm>.<dd>-<6 hex>`, the date (UTC) and commit of the tree it was built from, e.g. `v2026.10.11-d2134d`: `tools/current-tree-version.sh [commit]` prints it. `build.sh` stamps it into the app (`VO_VERSION`, shown as `VO.VERSION` on the Start Center and in About) and names the files with it. Windows wants numbers: the exe's file version is `2026.10.11` and the MSI's ProductVersion `26.10.11` (three numbers, the first two below 256), so Windows Installer, like `VO.compareVersions`, compares by date alone. A plain `cargo build` says `dev`.

`public/updater/current.json`, edited by hand (nothing updates it): per policy, per platform (`web`, `macos`, `windows`, `linux`), the version an edition must be at least.

    { "show-update-button": { "windows": "v2026.10.11-000000", … },
      "show-update-dialog": { "windows": "v2026.10.11-000000", … } }

`public/updater/whatsnew.json`, also by hand: one list for every platform, version → plain text (line breaks kept).

    { "v2026.10.11-000000": "VibeOffice for Windows and Linux: …" }

When the Start Center opens, the desktop app reads `https://vibeoffice.work/updater/current.json` (the site sends `Access-Control-Allow-Origin: *`; nothing about the user or their files is sent). Older than `show-update-dialog`: the Update dialog, at most once a day (`vibeoffice.updateAsked`), listing the `whatsnew.json` entries newer than this version, newest first (by date; the dialog shows without them if that file cannot be read); older than `show-update-button`: the Update VibeOffice button in the Start Center. `whatsnew.json` is read only when an update is due. Update opens `https://vibeoffice.work/updater/?from_version=<version>&current_platform=<platform>` in the default browser. Offline, or a file that is not this JSON: nothing is shown. A `dev` build is newer than any dated version and never asks. To try both against the published file without asking anyone else: keep `show-update-dialog` older than `show-update-button` (`v2026.10.05` and `v2026.10.11`) and build exes stamped in between and before (`VO_VERSION=v2026.10.08-000000` → the button only; `v2026.10.01-000000` → the dialog), e.g. `VO_VERSION=… TAURI_CONFIG='{"version":"2026.10.8"}' cargo build --release`; the dialog shows once a day per profile (`vibeoffice.updateAsked`). `tests/desktop/host.test.mjs` checks the repo's `current.json` the same way.

## Building

Needs Rust with the `x86_64-pc-windows-gnu` target, mingw-w64 (`x86_64-w64-mingw32-gcc`, `windres`), `wixl` (msitools) and `zip`; builds on Linux, no Windows SDK.

    desktop/build.sh        # desktop/target/dist/: VibeOffice-v2026.10.11-d2134d-x64.msi and .zip

`cd windows && cargo build --release` builds the exe alone (`target/x86_64-pc-windows-gnu/release/`). `cargo build --no-default-features` leaves out the embedded pages and loads `devUrl` (http://127.0.0.1:8760/, `tools/serve.py`), so page edits show on reload without rebuilding.

CI runs only by hand: Actions ▸ Windows ▸ Run workflow (pick the branch; tick *pre-release* if it is one). It runs `build.sh` on Ubuntu, keeps the MSI and zip as the run's artifact (`VibeOffice-<version>-windows-x64`) and publishes them as a GitHub release tagged with the version (`v2026.10.11-d2134d`, at the commit built); running it again on the same commit replaces the release's files. `public/updater/current.json` is not touched: raising the versions there is what makes installed copies offer the update.

## The installer

`vibeoffice.wxs`, built by `wixl -a x64` (Tauri's own MSI bundler needs WiX on Windows):

- per machine, into `Program Files\VibeOffice` (`vibeoffice.exe`, `WebView2Loader.dll`, `LICENSE.txt`), a Start menu shortcut, the icon in Apps & features;
- upgrades: `UpgradeCode` stays fixed; a newer or equal version (by date: `26.10.11`) replaces the installed one, an older one stops with "A newer version of VibeOffice is already installed.";
- file types `.docx` (Quire Document), `.xlsx` (Ledger Worksheet) and `.pptx` (Lectern Presentation): a ProgID each (`VibeOffice.docx`, … with `"…\vibeoffice.exe" "%1"`), listed under the extension's `OpenWithProgids` and in the app's Default apps capabilities (`RegisteredApplications`). VibeOffice is offered in Open with and Default apps; it never takes a type over (Windows asks the user), and uninstalling leaves other programs' entries alone. More types: add them to `Capabilities\FileAssociations`, `SupportedTypes` and a `Type…` component.

## Linux

The same crate builds for Linux against WebKitGTK 4.1, GTK 3 and libsoup 3 (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`):

    cd windows && cargo build --release --target x86_64-unknown-linux-gnu

Run it with a file to open: `target/x86_64-unknown-linux-gnu/release/vibeoffice ~/Budget.csv`. No package yet (`.deb`, AppImage, a `.desktop` file with the MIME types).

## Size

| Build (2026-10-11, Tauri 2.12.3, rustc 1.95) | Size |
|---|---|
| `vibeoffice.exe`, release | 6.9 MB (6.92) |
| of which `public/` (11 MB, brotli quality 9) | about 4.1 MB |
| `WebView2Loader.dll`, beside the exe (GNU target) | 160 KB |
| `VibeOffice-v2026.10.11-d2134d-x64.msi` / `.zip` | 5.6 MB / 5.4 MB |
| `vibeoffice`, Linux release | 7.2 MB |

Licenses: `tools/oss-licenses.py` lists the crates `desktop/Cargo.toml` depends on directly (`tauri`, `serde`, `serde_json`, `windows`; not their own dependencies, nor `tauri-build`, which only runs at build time) with the license files from each package, and the DLL that ships beside the exe (`WebView2Loader.dll`), in `public/oss-licenses.html`; run it after changing a dependency.

No exe packers (UPX): antivirus flags packed exes. The largest pages are the thesaurus (`common/dict/en.thes`, 2 MB) and the two word lists (650 KB each).

## Results

- Linux (Debian 13, WebKitGTK 2.52.6, Xfce): Start Center, all three apps; `vibeoffice Budget.csv` opens it in Ledger and `Notes.md` in Quire, the title bar follows the document; Recent Files and the look are kept between runs. With no network at all (`unshare -rn`), a fresh profile: everything loads, in Paper; the GitHub button goes to `xdg-open`; UI size 150 % and 200 % scale the whole UI, sharp, and are back after a restart; the Start Center keeps Settings reachable in its narrow layout. Started with `Budget.csv`, the Start Center stays and Ledger opens in a window of its own; Quire from the Start Center opens a third window, and its File ▸ Exit closes only that one.
- Not yet run against the published site: the update check (the site has no `updater/current.json` yet).
- Windows: built, not yet run. To check: the MSI installs, upgrades and uninstalls; Open with lists VibeOffice for .docx, .xlsx and .pptx and opens the file in its app; all three apps, saving, drops.

## Known limits / to do

- GNU builds import `WebView2Loader.dll`, which ships beside the exe (Microsoft's static loader is MSVC-only).
- Saving goes to the Downloads folder (Saving, above); writing the real file is planned in todos/DESKTOP_REAL_SAVE.md.
- Opening a file while the app runs starts a second process with its own Start Center (single instance is planned). Closing the Start Center's window leaves the app windows open, with no way back to it but starting the app again.
- The Start Center's wording is the web's ("Office suite in your browser", "Recent files are kept in this browser only").
- Each file type uses the app icon; Quire, Ledger and Lectern document icons would match the apps.
- Code signing (SmartScreen warns about unsigned installers).
