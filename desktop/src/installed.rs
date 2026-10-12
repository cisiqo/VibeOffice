//! The installed app's side of the installation on Windows: `vibeoffice.exe -uninstall` (Apps &
//! features) and what the user chose in the installer, done at the first start: the taskbar pin request
//! (Windows wants it from the app itself, in front) and Windows' Default apps page. The installer is
//! setup/; what both write and remove is in installation.rs.

use crate::installation::{self as inst, win};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use windows::{
    core::{BOOL, HSTRING, PCWSTR, PWSTR},
    Win32::{
        Foundation::CloseHandle,
        System::{
            Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
            Diagnostics::ToolHelp::*,
            LibraryLoader::GetModuleHandleW,
            Threading::*,
        },
        UI::{Controls::*, Shell::*, WindowsAndMessaging::*},
    },
    UI::Shell::TaskbarManager,
};

static PIN: AtomicBool = AtomicBool::new(false);
static DEFAULTS: AtomicBool = AtomicBool::new(false);

/// Before anything else: false when this run was the uninstaller and the process ends.
pub fn start() -> bool {
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(inst::APP_ID));
    }
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.iter().any(|a| a == inst::UNINSTALL_ARG) {
        uninstall();
        return false;
    }
    take_args(&args);
    remove_replaced();
    true
}

/// What the installer asked for, from this process's arguments or a second start's (main.rs); done by
/// after_install
pub fn take_args<S: AsRef<std::ffi::OsStr>>(args: &[S]) {
    let has = |flag: &str| args.iter().any(|a| a.as_ref() == flag);
    PIN.fetch_or(has(inst::PIN_ARG), Ordering::Relaxed);
    DEFAULTS.fetch_or(has(inst::DEFAULTS_ARG), Ordering::Relaxed);
}

/// Files an update renamed because this version was running (setup/: `*.old`)
fn remove_replaced() {
    let (Ok(exe), Some(dir)) = (std::env::current_exe(), win::install_dir()) else {
        return;
    };
    if !exe.parent().is_some_and(|d| win::same_path(d, &dir)) {
        return;
    }
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if entry.path().extension().is_some_and(|e| e == "old") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The Start Center's first page has loaded: ask to be pinned, then open Default apps, as chosen in
/// the installer (once).
pub fn after_install(window: &tauri::WebviewWindow) {
    let pin = PIN.swap(false, Ordering::Relaxed);
    let defaults = DEFAULTS.swap(false, Ordering::Relaxed);
    if !pin && !defaults {
        return;
    }
    win::log(&format!("first start: pin {pin}, default apps {defaults}"));
    let window = window.clone();
    // TaskbarManager wants the foreground UI thread
    let _ = window.clone().run_on_main_thread(move || {
        let request = if pin { request_pin() } else { None };
        match request {
            // Windows asks the user; Settings opens after their answer, not over the question,
            // from this thread again (ShellExecute wants its COM apartment)
            Some(answer) => {
                std::thread::spawn(move || {
                    win::log(&format!("pin answer: {:?}", answer.join()));
                    if defaults {
                        let _ = window.run_on_main_thread(open_default_apps);
                    }
                });
            }
            None if defaults => open_default_apps(),
            None => {}
        }
    });
}

/// Windows' question whether to pin the app, if it lets the app ask
fn request_pin() -> Option<windows_future::IAsyncOperation<bool>> {
    let taskbar = TaskbarManager::GetDefault();
    let allowed = taskbar.as_ref().map(|t| t.IsPinningAllowed());
    win::log(&format!(
        "taskbar: {:?}, pinning allowed: {allowed:?}",
        taskbar.as_ref().err()
    ));
    if !matches!(allowed, Ok(Ok(true))) {
        return None;
    }
    let request = taskbar.ok()?.RequestPinCurrentAppAsync();
    win::log(&format!("pin request: {:?}", request.as_ref().err()));
    request.ok()
}

fn open_default_apps() {
    let opened = crate::host::system_open(inst::DEFAULT_APPS)
        .or_else(|_| crate::host::system_open("ms-settings:defaultapps"));
    win::log(&format!("default apps: {opened:?}"));
}

fn uninstall() {
    let Some(dir) = win::install_dir() else {
        return;
    };
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let Some(delete_data) = confirm() else {
        return;
    };
    while running_from(&dir) {
        let answer = message(
            "VibeOffice is open. Close all its windows, then choose Retry.",
            MB_RETRYCANCEL | MB_ICONINFORMATION,
        );
        if answer != IDRETRY {
            return;
        }
    }

    let exe = dir.join(inst::EXE);
    for lnk in win::shortcuts().into_iter().chain(win::pinned_shortcut()) {
        if win::shortcut_target(&lnk).is_some_and(|target| win::same_path(&target, &exe)) {
            let _ = std::fs::remove_file(&lnk);
        }
    }
    win::remove();
    win::notify_associations();
    if delete_data {
        for base in [FOLDERID_LocalAppData, FOLDERID_RoamingAppData] {
            if let Some(d) = win::known_folder(&base) {
                let _ = std::fs::remove_dir_all(d.join(inst::DATA_DIR));
            }
        }
    }

    // The folder: what can go now, then the rest (this exe, its WebView2Loader.dll) once it has ended
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
    if std::fs::remove_dir(&dir).is_err() && dir.exists() {
        remove_after_exit(&dir);
    }
}

/// Uninstall, keeping or deleting the user's data, or None
fn confirm() -> Option<bool> {
    let title = HSTRING::from("VibeOffice");
    let heading = HSTRING::from("Uninstall VibeOffice?");
    let text = HSTRING::from("Your documents stay where they are.");
    let data = HSTRING::from("Also delete VibeOffice's settings, Recent Files list and drafts");
    let uninstall = HSTRING::from("Uninstall");
    let buttons = [TASKDIALOG_BUTTON {
        nButtonID: 100,
        pszButtonText: PCWSTR(uninstall.as_ptr()),
    }];
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hInstance: unsafe { GetModuleHandleW(None) }.ok()?.into(),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
        dwCommonButtons: TDCBF_CANCEL_BUTTON,
        pszWindowTitle: PCWSTR(title.as_ptr()),
        // the app's icon (tauri-build's resource 32512)
        Anonymous1: TASKDIALOGCONFIG_0 {
            pszMainIcon: PCWSTR(32512 as *const u16),
        },
        pszMainInstruction: PCWSTR(heading.as_ptr()),
        pszContent: PCWSTR(text.as_ptr()),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: 100,
        pszVerificationText: PCWSTR(data.as_ptr()),
        ..Default::default()
    };
    let mut button = 0;
    let mut checked = BOOL(0);
    unsafe { TaskDialogIndirect(&config, Some(&mut button), None, Some(&mut checked)) }.ok()?;
    (button == 100).then_some(checked.as_bool())
}

fn message(text: &str, style: MESSAGEBOX_STYLE) -> MESSAGEBOX_RESULT {
    unsafe {
        MessageBoxW(
            None,
            &HSTRING::from(text),
            &HSTRING::from("VibeOffice"),
            style,
        )
    }
}

/// Whether another VibeOffice process runs from the install folder
fn running_from(dir: &Path) -> bool {
    let me = std::process::id();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more && !found {
            let name_len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);
            if entry.th32ProcessID != me && name.eq_ignore_ascii_case(inst::EXE) {
                if let Ok(process) = OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION,
                    false,
                    entry.th32ProcessID,
                ) {
                    let mut buf = [0u16; 1024];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_WIN32,
                        PWSTR(buf.as_mut_ptr()),
                        &mut len,
                    )
                    .is_ok()
                    {
                        let path = std::path::PathBuf::from(String::from_utf16_lossy(
                            &buf[..len as usize],
                        ));
                        found = path.parent().is_some_and(|d| win::same_path(d, dir));
                    }
                    let _ = CloseHandle(process);
                }
            }
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

/// A hidden cmd.exe from System32 waits for this process to end, then removes the folder.
fn remove_after_exit(dir: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Some(system) = win::known_folder(&FOLDERID_System) else {
        return;
    };
    let _ = std::process::Command::new(system.join("cmd.exe"))
        .raw_arg(format!(
            r#"/d /c ping -n 3 127.0.0.1 >nul & rd /s /q "{}""#,
            dir.display()
        ))
        .current_dir(std::env::temp_dir())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}
