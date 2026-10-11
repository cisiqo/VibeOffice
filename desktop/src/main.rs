// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;

use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// A window of the suite: the Start Center ("main") or an app (host_new_window). Every window gets the
/// host script, title, link, drop and UI size handling.
pub fn open_window(app: &AppHandle, label: &str, url: WebviewUrl) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, label, url)
        .title("VibeOffice")
        .inner_size(1280.0, 820.0)
        .min_inner_size(640.0, 480.0)
        .initialization_script(host::init_script())
        // The pages take dropped files themselves (Start Center, each app).
        .disable_drag_drop_handler()
        // Links out of the app (the Start Center's GitHub button, hyperlinks in documents and
        // slide shows) open in the default browser, not in this window or a bare popup.
        .on_navigation(|url| {
            if !host::is_external(url) {
                return true;
            }
            let _ = host::open_external(url);
            false
        })
        .on_new_window(|url, _| {
            if !host::is_external(&url) {
                return NewWindowResponse::Allow;
            }
            let _ = host::open_external(&url);
            NewWindowResponse::Deny
        })
        // Saving, for now: every save is a download into the Downloads folder (host::download_destination
        // decides what may be written where); the window is then told the name the file got.
        .on_download(|webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                let Ok(dir) = webview.path().download_dir() else {
                    return false;
                };
                match host::download_destination(&url, destination, &dir) {
                    Some(path) => {
                        *destination = path;
                        true
                    }
                    None => false,
                }
            }
            DownloadEvent::Finished { path, success, .. } => {
                let js = webview
                    .state::<host::Host>()
                    .downloaded(webview.label(), path, success);
                let _ = webview.eval(js);
                true
            }
            _ => true,
        })
        // The system title bar shows the page's title, as in the installed PWA.
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        // The UI size (Settings), as each page starts: WebKitGTK resets the zoom on the first load.
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Started {
                let scale = window.state::<host::Host>().ui_scale();
                let _ = window.set_zoom(scale);
            }
        })
        .build()
}

fn main() {
    tauri::Builder::default()
        .manage(host::Host::from_args())
        .invoke_handler(tauri::generate_handler![
            host::host_launch_files,
            host::host_read,
            host::host_open_url,
            host::host_ui_scale,
            host::host_set_ui_scale,
            host::host_new_window,
            host::host_close_window,
            host::host_show_downloads
        ])
        .setup(|app| {
            app.state::<host::Host>().load_settings(app.handle());
            open_window(app.handle(), "main", WebviewUrl::default())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running VibeOffice");
}
