//! The native side of `VO.host` (public/common/suite.js; contract in docs/desktop.md, Host interface).
//!
//! Pages reach the system only through VO.host. Here it is a set of `host_*` commands over Tauri's IPC and
//! `window.__VO_HOST__`, set before every page's scripts. Files cross as handles: numbers this process gives
//! out for paths the user or the system chose (so far the command line), so a page reads only what it was given.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow};

/// Version of the interface; raise it when a command changes shape (VO.host.version in the pages).
pub const VERSION: u32 = 1;

#[derive(Default)]
pub struct Host {
    /// handle -> path
    files: Mutex<Vec<PathBuf>>,
    /// handles of the files this process was started with, until a page takes them
    launch: Mutex<Vec<usize>>,
    settings: Mutex<Settings>,
    /// window label -> the file its last save went to (downloads, until real saving: todos/DESKTOP_REAL_SAVE.md)
    downloads: Mutex<HashMap<String, PathBuf>>,
}

/// What the native side keeps for itself, in settings.json in the app's config folder: what has to apply
/// before a page loads. The pages' own settings stay in their localStorage.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// the web view's zoom: the whole UI, as the browser's Ctrl + does (1 = 100 %)
    ui_scale: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { ui_scale: 1.0 }
    }
}

const UI_SCALE: std::ops::RangeInclusive<f64> = 0.5..=4.0;

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

#[derive(Serialize)]
pub struct FileRef {
    handle: usize,
    name: String,
}

impl Host {
    /// The files on the command line: Open with, a double-click on an associated file ("%1").
    pub fn from_args() -> Self {
        let host = Host::default();
        let cwd = std::env::current_dir().unwrap_or_default();
        host.add_launch_files(std::env::args_os().skip(1), &cwd);
        host
    }

    /// The files among a command line's arguments (this process's, or those another start of the app
    /// handed over: one instance on Windows), relative ones from `cwd`, for the page that takes them
    /// (`host_launch_files`). Whether there were any.
    pub fn add_launch_files<I: IntoIterator<Item = impl Into<PathBuf>>>(
        &self,
        args: I,
        cwd: &Path,
    ) -> bool {
        let mut any = false;
        for arg in args {
            let path = cwd.join(arg.into());
            if path.is_file() {
                let handle = self.grant(std::path::absolute(&path).unwrap_or(path));
                self.launch.lock().unwrap().push(handle);
                any = true;
            }
        }
        any
    }

    /// Reads settings.json (missing or unreadable: the defaults).
    pub fn load_settings(&self, app: &AppHandle) {
        let read = settings_path(app)
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice::<Settings>(&b).ok());
        let mut settings = self.settings.lock().unwrap();
        if let Some(s) = read {
            if UI_SCALE.contains(&s.ui_scale) {
                *settings = s;
            }
        }
    }

    pub fn ui_scale(&self) -> f64 {
        self.settings.lock().unwrap().ui_scale
    }

    fn grant(&self, path: PathBuf) -> usize {
        let mut files = self.files.lock().unwrap();
        files.push(path);
        files.len() - 1
    }

    fn file_ref(&self, handle: usize) -> FileRef {
        let files = self.files.lock().unwrap();
        let name = files[handle]
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        FileRef { handle, name }
    }

    fn path(&self, handle: usize) -> Result<PathBuf, String> {
        self.files
            .lock()
            .unwrap()
            .get(handle)
            .cloned()
            .ok_or_else(|| format!("no file with handle {handle}"))
    }
}

/// The script that runs before each page's own: what the pages see as the host, and the desktop app's
/// default look (Paper) until the user picks one (the pages' head scripts read it).
pub fn init_script() -> String {
    format!(
        "window.__VO_HOST__ = Object.freeze({{ platform: '{}', version: {VERSION}, appVersion: '{}' }});\n\
         try {{ if (!localStorage.getItem('vibeoffice.look')) localStorage.setItem('vibeoffice.look', 'paper'); }} catch (e) {{}}",
        std::env::consts::OS, // windows, linux, macos
        option_env!("VO_VERSION").unwrap_or("dev") // tools/current-tree-version.sh, from build.sh
    )
}

/// The files the system asked us to open, once: the page that takes them opens them.
#[tauri::command]
pub fn host_launch_files(host: State<Host>) -> Vec<FileRef> {
    let handles: Vec<usize> = host.launch.lock().unwrap().drain(..).collect();
    handles.into_iter().map(|h| host.file_ref(h)).collect()
}

/// The UI scale (1 = 100 %).
#[tauri::command]
pub fn host_ui_scale(host: State<Host>) -> f64 {
    host.ui_scale()
}

/// Scales the whole UI of every window (the web view's zoom) and keeps it for the next start.
#[tauri::command]
pub fn host_set_ui_scale(app: AppHandle, host: State<Host>, scale: f64) -> Result<(), String> {
    if !UI_SCALE.contains(&scale) {
        return Err(format!(
            "UI scale {scale} is outside {}..{}",
            UI_SCALE.start(),
            UI_SCALE.end()
        ));
    }
    for window in app.webview_windows().values() {
        window.set_zoom(scale).map_err(|e| e.to_string())?;
    }
    let settings = {
        let mut s = host.settings.lock().unwrap();
        s.ui_scale = scale;
        s.clone()
    };
    let path = settings_path(&app).ok_or("no settings folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| describe(dir, e))?;
    }
    let json = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| describe(&path, e))
}

/// Opens one of the app's own pages in a new window (an app from the Start Center, as when the PWA is
/// installed). Async: creating a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn host_new_window(
    app: AppHandle,
    window: WebviewWindow,
    url: String,
) -> Result<(), String> {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    let url = Url::parse(&url).map_err(|e| format!("{url}: {e}"))?;
    let here = window.url().map_err(|e| e.to_string())?;
    // scheme, host and port: Url::origin() is opaque for tauri://localhost, and opaque origins never match
    let site = |u: &Url| {
        (
            u.scheme().to_string(),
            u.host_str().map(str::to_string),
            u.port_or_known_default(),
        )
    };
    if site(&url) != site(&here) {
        return Err(format!("not one of the app's pages: {url}"));
    }
    let mut path = url.path().trim_start_matches('/').to_string();
    if let Some(q) = url.query() {
        path = format!("{path}?{q}");
    }
    let label = format!("doc-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    crate::open_window(&app, &label, WebviewUrl::App(PathBuf::from(path)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// File ▸ Exit in an app window: closes it (true). The Start Center's window ("main") stays (false).
#[tauri::command]
pub fn host_close_window(window: WebviewWindow) -> Result<bool, String> {
    if window.label() == "main" {
        return Ok(false);
    }
    window.close().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Opens a web or mail address in the system's browser or mail program.
#[tauri::command]
pub fn host_open_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("{url}: {e}"))?;
    if !is_external(&parsed) {
        return Err(format!("not a web or mail address: {url}"));
    }
    open_external(&parsed)
}

/// Whether a page wants to leave the app: http(s) to another host, or mailto. The app's own pages
/// (tauri://localhost, http://tauri.localhost; devUrl in a dev build), blob:, data: and about: stay.
pub fn is_external(url: &Url) -> bool {
    match url.scheme() {
        "mailto" => true,
        "http" | "https" => {
            let own = url.host_str() == Some("tauri.localhost")
                || (!cfg!(feature = "custom-protocol") && url.host_str() == Some("127.0.0.1"));
            !own
        }
        _ => false,
    }
}

/// Hands an address to the system (the default browser), never to a program or a file.
pub fn open_external(url: &Url) -> Result<(), String> {
    system_open(url.as_str())
}

#[cfg(windows)]
pub(crate) fn system_open(url: &str) -> Result<(), String> {
    use windows::{
        core::{w, HSTRING, PCWSTR},
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };
    let r = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &HSTRING::from(url),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // above 32 is success
    if r.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!(
            "could not open {url} (ShellExecute {})",
            r.0 as isize
        ))
    }
}

#[cfg(not(windows))]
pub(crate) fn system_open(url: &str) -> Result<(), String> {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut child = std::process::Command::new(cmd)
        .arg(url)
        .spawn()
        .map_err(|e| format!("{cmd}: {e}"))?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/* ------------------------------------------------------------ saving, for now: the Downloads folder */

/// The file types the apps save and export: the only ones a download may write.
const SAVE_TYPES: &[&str] = &[
    "docx", "docm", "dotx", "dotm", "rtf", "htm", "html", "txt", "md", "zip", "xlsx", "xlsm",
    "xltx", "xltm", "csv", "tsv", "prn", "xml", "pptx", "pptm", "ppsx", "ppsm", "potx", "potm",
    "pdf", "png",
];

/// Where a download goes, or None to refuse it: only the pages' own files (blob: and data: URLs, made by
/// L.saveFile), only SAVE_TYPES, always straight in `dir` (the Downloads folder) under the bare file name the web
/// view suggests (it already numbers a taken name: "name (1).ext"), never over an existing file (then " (n)").
pub fn download_destination(url: &Url, suggested: &Path, dir: &Path) -> Option<PathBuf> {
    if !matches!(url.scheme(), "blob" | "data") {
        return None;
    }
    let name = suggested.file_name()?.to_str()?.trim();
    let (stem, ext) = name.rsplit_once('.')?;
    let ext = ext.to_ascii_lowercase();
    if stem.trim().is_empty()
        || !SAVE_TYPES.contains(&ext.as_str())
        || name.contains(['/', '\\', ':'])
    {
        return None;
    }
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while path.symlink_metadata().is_ok() {
        path = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    Some(path)
}

impl Host {
    /// A window's save finished: remember the file (for Browse) and tell that window, with the name the file
    /// really got. Nothing about the file comes from the page.
    pub fn downloaded(&self, label: &str, path: Option<PathBuf>, ok: bool) -> String {
        let name = path
            .as_deref()
            .and_then(Path::file_name)
            .map(|n| n.to_string_lossy().into_owned());
        match (&path, ok) {
            (Some(p), true) => {
                self.downloads
                    .lock()
                    .unwrap()
                    .insert(label.to_string(), p.clone());
            }
            _ => {
                self.downloads.lock().unwrap().remove(label);
            }
        }
        let detail = serde_json::json!({ "ok": ok && name.is_some(), "name": name });
        format!("window.dispatchEvent(new CustomEvent('vo-download', {{ detail: {detail} }}));")
    }
}

/// Browse: the Downloads folder, with this window's last saved file selected where the system can (Windows).
/// Takes nothing from the page: the folder is the system's, the file is the one this app wrote.
#[tauri::command]
pub fn host_show_downloads(
    app: AppHandle,
    window: WebviewWindow,
    host: State<Host>,
) -> Result<(), String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let last = host
        .downloads
        .lock()
        .unwrap()
        .get(window.label())
        .cloned()
        .filter(|p| p.parent() == Some(dir.as_path()) && p.is_file());
    reveal(&dir, last.as_deref())
}

#[cfg(windows)]
fn reveal(dir: &Path, file: Option<&Path>) -> Result<(), String> {
    if let Some(file) = file {
        use std::os::windows::process::CommandExt;
        // a file name cannot hold a quote on Windows, so this cannot break out of the argument
        let mut child = std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", file.display()))
            .spawn()
            .map_err(|e| format!("explorer: {e}"))?;
        std::thread::spawn(move || child.wait());
        return Ok(());
    }
    system_open(&dir.to_string_lossy())
}

#[cfg(not(windows))]
fn reveal(dir: &Path, _file: Option<&Path>) -> Result<(), String> {
    system_open(&dir.to_string_lossy())
}

/// A file's bytes (an ArrayBuffer in the page).
#[tauri::command]
pub fn host_read(host: State<Host>, handle: usize) -> Result<Response, String> {
    let path = host.path(handle)?;
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| describe(&path, e))
}

fn describe(path: &Path, e: std::io::Error) -> String {
    format!("{}: {e}", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_files_are_the_files_among_the_arguments_relative_to_the_starts_folder() {
        let dir = std::env::temp_dir().join(format!("vo-launch-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("Budget.csv"), "a,b").unwrap();
        let host = Host::default();
        let other = std::env::temp_dir();
        assert!(host.add_launch_files(
            ["-choose-defaults", "sub/Budget.csv", "missing.docx", "sub"],
            &dir
        ));
        assert!(!host.add_launch_files(["-pin-taskbar"], &other));
        let absolute = dir.join("sub").join("Budget.csv");
        assert!(
            host.add_launch_files([absolute.clone()], &other),
            "an absolute path stays as it is"
        );
        let launched: Vec<PathBuf> = host
            .launch
            .lock()
            .unwrap()
            .iter()
            .map(|&h| host.path(h).unwrap())
            .collect();
        assert_eq!(launched, [absolute.clone(), absolute]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn dest(url: &str, name: &str, dir: &Path) -> Option<PathBuf> {
        download_destination(&Url::parse(url).unwrap(), Path::new(name), dir)
    }

    #[test]
    fn downloads_only_the_pages_own_files_of_the_types_we_save() {
        let dir = std::env::temp_dir().join(format!("vo-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let blob = "blob:http://tauri.localhost/0b6c";
        assert_eq!(
            dest(blob, "/x/y/Report.docx", &dir),
            Some(dir.join("Report.docx"))
        );
        assert_eq!(
            dest("data:application/pdf;base64,AA", "Deck.PDF", &dir),
            Some(dir.join("Deck.pdf"))
        );
        assert_eq!(
            dest("https://example.com/a.docx", "a.docx", &dir),
            None,
            "not a page's own file"
        );
        assert_eq!(dest(blob, "run.exe", &dir), None, "not a type we save");
        assert_eq!(dest(blob, "noext", &dir), None);
        assert_eq!(dest(blob, ".docx", &dir), None);
        std::fs::write(dir.join("Book.xlsx"), b"x").unwrap();
        std::fs::write(dir.join("Book (2).xlsx"), b"x").unwrap();
        assert_eq!(
            dest(blob, "Book.xlsx", &dir),
            Some(dir.join("Book (3).xlsx")),
            "never over an existing file"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_notice_names_only_the_file_written() {
        let host = Host::default();
        let js = host.downloaded(
            "doc-1",
            Some(PathBuf::from("/home/u/Downloads/a\"b.docx")),
            true,
        );
        assert!(js.contains(r#""name":"a\"b.docx""#), "{js}");
        assert!(!js.contains("/home/u"), "no path to the page");
        assert_eq!(
            host.downloads.lock().unwrap().get("doc-1"),
            Some(&PathBuf::from("/home/u/Downloads/a\"b.docx"))
        );
        let js = host.downloaded("doc-1", None, false);
        assert!(js.contains(r#""ok":false"#));
        assert!(host.downloads.lock().unwrap().get("doc-1").is_none());
    }
}
