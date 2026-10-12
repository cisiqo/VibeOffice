//! VibeOfficeSetup.exe installs VibeOffice for the current user, without administrator rights, into
//! %LOCALAPPDATA%\VibeOffice. It writes the app it carries (vibeoffice.exe, WebView2Loader.dll,
//! LICENSE.txt), the desktop and Start menu shortcuts, the file types and the Apps & features entry. All of
//! that is listed in ../src/installation.rs, the same list `vibeoffice.exe -uninstall` removes. Then it
//! starts the app with the user's choices, the taskbar pin request and Windows' Default apps page
//! (../src/installed.rs). With this very app already installed, it offers to install it again.
//!
//! It runs from Downloads, so it never loads a DLL from its own folder. It imports only Known DLLs
//! (build.sh checks), and before anything else it limits every later load to System32.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
#[path = "../../src/installation.rs"]
mod installation;

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() {
    setup::run()
}

#[cfg(windows)]
mod setup {
    use crate::installation::{self as inst, win, Install, EXE, FILES};
    use std::{
        ffi::OsString,
        path::{Path, PathBuf},
    };
    use windows::{
        core::{w, Interface, HSTRING, PCWSTR},
        Win32::{
            Foundation::*,
            Graphics::Gdi::*,
            Storage::EnhancedStorage::PKEY_AppUserModel_ID,
            System::{
                Com::{StructuredStorage::PROPVARIANT, *},
                LibraryLoader::*,
                Registry::*,
                SystemInformation::GetLocalTime,
                Variant::VT_LPWSTR,
            },
            UI::{
                Controls::*,
                Shell::{PropertiesSystem::IPropertyStore, *},
                WindowsAndMessaging::*,
            },
        },
        UI::Shell::{ITaskbarManagerDesktopAppSupportStatics, TaskbarManager},
    };

    const VERSION: &str = match option_env!("VO_VERSION") {
        Some(v) => v,
        None => "dev",
    };
    /// FILES' contents, in that order
    const PAYLOAD: [&[u8]; 3] = [
        include_bytes!(concat!(env!("VO_PAYLOAD"), "/vibeoffice.exe")),
        include_bytes!(concat!(env!("VO_PAYLOAD"), "/WebView2Loader.dll")),
        include_bytes!("../../../LICENSE"),
    ];

    pub fn run() {
        unsafe {
            // Before anything loads a DLL: System32 only, never this exe's folder
            let _ = SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let _ = std::fs::remove_file(std::env::temp_dir().join("VibeOfficeSetup.log"));
        win::log(&format!("VibeOfficeSetup {VERSION}"));
        std::panic::set_hook(Box::new(|p| win::log(&format!("stopped: {p}"))));
        let Some(dir) = win::install_dir() else {
            fail("Windows did not say where the local application data folder is.");
            return;
        };
        // Files dropped on the installer open in the app
        let files: Vec<OsString> = std::env::args_os()
            .skip(1)
            .map(|f| {
                std::path::absolute(&f)
                    .map(PathBuf::into_os_string)
                    .unwrap_or(f)
            })
            .collect();
        let installed = win::installed_version().filter(|_| dir.join(EXE).is_file());
        win::log(&format!("installed: {installed:?} in {}", dir.display()));
        // This very app already installed (byte for byte, whatever the version says): offered again,
        // which also repairs what is missing
        let same =
            installed.is_some() && std::fs::read(dir.join(EXE)).is_ok_and(|exe| exe == PAYLOAD[0]);

        let mut choices = Choices {
            can_pin: can_ask_to_pin(),
            pin: installed.is_none(),
            // Ticked unless the user has already chosen VibeOffice for all three types
            defaults: !win::chosen_for_all_types(),
            font: HFONT::default(),
            heading: HSTRING::new(),
            text: HSTRING::new(),
            button: HSTRING::new(),
        };
        let shown = dir.display();
        match &installed {
            None => {
                choices.heading = "Install VibeOffice".into();
                choices.text = format!(
                    "VibeOffice {VERSION} will be installed for you in {shown}, with shortcuts on your desktop \
                     and in the Start menu. No administrator rights are needed."
                )
                .into();
                choices.button = "&Install".into();
            }
            Some(_) if same => {
                choices.heading = "Reinstall VibeOffice".into();
                choices.text = format!(
                    "VibeOffice {VERSION} is installed in {shown}. Setup can install it again, with its \
                     shortcuts and file types; your settings, Recent Files and drafts stay."
                )
                .into();
                choices.button = "&Reinstall".into();
            }
            Some(old) => {
                choices.heading = "Update VibeOffice".into();
                choices.text = format!(
                    "VibeOffice {old} is installed in {shown}. Setup replaces it with {VERSION}; your \
                     settings, Recent Files and drafts stay."
                )
                .into();
                choices.button = "&Update".into();
            }
        }
        win::log(&format!(
            "can ask to pin: {}; VibeOffice chosen for all three types: {}",
            choices.can_pin, !choices.defaults
        ));
        if !ask(&mut choices) {
            win::log("cancelled");
            return;
        }
        win::log(&format!(
            "chosen: pin {}, default app settings {}",
            choices.pin, choices.defaults
        ));
        let warnings = match install(&dir) {
            Ok(warnings) => warnings,
            Err(e) => {
                win::log(&format!("failed: {e}"));
                fail(&format!("VibeOffice could not be installed.\n\n{e}"));
                return;
            }
        };
        // The file types are registered; which app opens them is the user's choice, in Settings: the
        // app asks to be pinned, then opens Default apps (without the app, Settings opens from here)
        let mut flags = Vec::new();
        if choices.pin {
            flags.push(inst::PIN_ARG);
        }
        if choices.defaults {
            flags.push(inst::DEFAULTS_ARG);
        }
        if !start(&dir, &flags, &files) && choices.defaults {
            open(inst::DEFAULT_APPS);
        }
        if !warnings.is_empty() {
            let text = format!("VibeOffice is installed, but:\n\n{}", warnings.join("\n"));
            unsafe {
                MessageBoxW(
                    None,
                    &HSTRING::from(text),
                    w!("VibeOffice Setup"),
                    MB_OK | MB_ICONWARNING,
                );
            }
        }
    }

    /// The app's files, then Apps & features and the file types, then the shortcuts (a shortcut that
    /// can't be made is a warning, not a failed install)
    fn install(dir: &Path) -> Result<Vec<String>, String> {
        let shown = |p: &Path, e: std::io::Error| format!("{}: {e}", p.display());
        std::fs::create_dir_all(dir).map_err(|e| shown(dir, e))?;
        // A DLL that is not ours never stays beside the app
        for entry in std::fs::read_dir(dir).map_err(|e| shown(dir, e))?.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.ends_with(".dll") && !FILES.iter().any(|f| f.eq_ignore_ascii_case(&name)) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        for (name, bytes) in FILES.iter().zip(PAYLOAD) {
            put(dir, name, bytes).map_err(|e| shown(&dir.join(name), e))?;
            win::log(&format!("wrote {name}"));
        }
        let today = unsafe { GetLocalTime() };
        win::set(&inst::values(&Install {
            dir: &dir.to_string_lossy(),
            version: VERSION,
            size_kb: (PAYLOAD.iter().map(|b| b.len()).sum::<usize>() / 1024) as u32,
            date: &format!("{:04}{:02}{:02}", today.wYear, today.wMonth, today.wDay),
        }))?;
        win::notify_associations();
        win::log("registered Apps & features and the file types");
        let exe = dir.join(EXE);
        let mut warnings = Vec::new();
        for lnk in win::shortcuts() {
            match shortcut(&lnk, &exe, dir) {
                Ok(()) => win::log(&format!("shortcut {}", lnk.display())),
                Err(e) => {
                    win::log(&format!("shortcut {} failed: {e}", lnk.display()));
                    warnings.push(format!(
                        "the shortcut {} could not be made ({e}).",
                        lnk.display()
                    ));
                }
            }
        }
        Ok(warnings)
    }

    /// Writes a file of the app. A running copy (an update while VibeOffice is open) can't be replaced
    /// but can be renamed: it becomes `*.old`, which the app removes when it next starts.
    fn put(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
        let target = dir.join(name);
        let new = dir.join(format!("{name}.new"));
        std::fs::write(&new, bytes)?;
        if std::fs::rename(&new, &target).is_ok() {
            return Ok(());
        }
        if target.exists() {
            let mut old = dir.join(format!("{name}.old"));
            for i in 1.. {
                if !old.exists() || std::fs::remove_file(&old).is_ok() {
                    break;
                }
                old = dir.join(format!("{name}.{i}.old"));
            }
            retry(|| std::fs::rename(&target, &old))?;
        }
        retry(|| std::fs::rename(&new, &target))
    }

    /// For a few seconds: an antivirus may still be reading a file just written
    fn retry(mut f: impl FnMut() -> std::io::Result<()>) -> std::io::Result<()> {
        for _ in 0..20 {
            if f().is_ok() {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        f()
    }

    fn shortcut(lnk: &Path, exe: &Path, dir: &Path) -> windows::core::Result<()> {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe.as_os_str()))?;
            link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str()))?;
            link.SetIconLocation(&HSTRING::from(exe.as_os_str()), 0)?;
            link.SetDescription(w!("Word processor, spreadsheet and presentations"))?;
            // The app's AppUserModelID (installed.rs sets the same on its process): taskbar pins go by it
            // The string is CoTaskMemAlloc'd: PROPVARIANT's Drop frees it (PropVariantClear)
            let mut value = PROPVARIANT::default();
            (*value.Anonymous.Anonymous).vt = VT_LPWSTR;
            (*value.Anonymous.Anonymous).Anonymous.pwszVal =
                SHStrDupW(&HSTRING::from(inst::APP_ID))?;
            let store: IPropertyStore = link.cast()?;
            store.SetValue(&PKEY_AppUserModel_ID, &value)?;
            store.Commit()?;
            link.cast::<IPersistFile>()?
                .Save(&HSTRING::from(lnk.as_os_str()), true)
        }
    }

    /// Starts the installed app, in front (this process had the user's click) and out of any job this
    /// installer runs in (Windows may watch installers in one), so that the app outlives it
    fn start(dir: &Path, flags: &[&str], files: &[OsString]) -> bool {
        use std::os::windows::process::CommandExt;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let exe = dir.join(EXE);
        let spawn = |creation: u32| {
            std::process::Command::new(&exe)
                .args(flags)
                .args(files)
                .current_dir(dir)
                .creation_flags(creation)
                .spawn()
        };
        match spawn(CREATE_BREAKAWAY_FROM_JOB).or_else(|_| spawn(0)) {
            Ok(child) => {
                win::log(&format!(
                    "started {} {flags:?} (process {})",
                    exe.display(),
                    child.id()
                ));
                unsafe {
                    let _ = AllowSetForegroundWindow(child.id());
                }
                true
            }
            Err(e) => {
                win::log(&format!("could not start {}: {e}", exe.display()));
                fail(&format!(
                    "VibeOffice could not be started.\n\n{}: {e}",
                    exe.display()
                ));
                false
            }
        }
    }

    fn open(uri: &str) {
        let r = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                &HSTRING::from(uri),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        win::log(&format!("opened {uri}: {}", r.0 as isize));
    }

    /// Whether Windows lets the app ask to be pinned: TaskbarManager for desktop apps, a taskbar, and
    /// no Limited Access Feature token needed (from KB5074105, builds 26100/26200.7705, on).
    fn can_ask_to_pin() -> bool {
        let token_needed = || {
            let mut value = 0u32;
            let mut size = 4u32;
            let err = unsafe {
                RegGetValueW(
                    HKEY_LOCAL_MACHINE,
                    w!(
                        r"SOFTWARE\Microsoft\Windows\CurrentVersion\AppModel\LimitedAccessFeatures\com.microsoft.windows.taskbar.pin"
                    ),
                    w!("4096B239A7295B635C090E647E867B5707DA6AB6CB78340B01FE4E0C8F4953D4"),
                    RRF_RT_REG_DWORD,
                    None,
                    Some(&mut value as *mut u32 as _),
                    Some(&mut size),
                )
            };
            err == ERROR_SUCCESS && value != 0
        };
        windows::core::factory::<TaskbarManager, ITaskbarManagerDesktopAppSupportStatics>().is_ok()
            && !token_needed()
            && TaskbarManager::GetDefault()
                .and_then(|t| t.IsSupported())
                .unwrap_or(false)
    }

    fn fail(text: &str) {
        unsafe {
            MessageBoxW(
                None,
                &HSTRING::from(text),
                w!("VibeOffice Setup"),
                MB_OK | MB_ICONERROR,
            );
        }
    }

    struct Choices {
        can_pin: bool,
        pin: bool,
        defaults: bool,
        font: HFONT,
        heading: HSTRING,
        text: HSTRING,
        button: HSTRING,
    }

    const HEADING: i32 = 10;
    const TEXT: i32 = 11;
    const PIN: i32 = 12;
    const PIN_HINT: i32 = 13;
    const DEFAULTS: i32 = 14;

    /// The install dialog (setup.rc): true to install, with the choices
    fn ask(choices: &mut Choices) -> bool {
        let result = unsafe {
            DialogBoxParamW(
                GetModuleHandleW(None).ok().map(Into::into),
                PCWSTR(1 as *const u16),
                None,
                Some(dialog),
                LPARAM(choices as *mut Choices as isize),
            )
        };
        if !choices.font.is_invalid() {
            unsafe {
                let _ = DeleteObject(choices.font.into());
            }
        }
        result == IDOK.0 as isize
    }

    unsafe extern "system" fn dialog(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> isize {
        unsafe {
            match msg {
                WM_INITDIALOG => {
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, lparam.0);
                    let c = &mut *(lparam.0 as *mut Choices);
                    let _ = SetDlgItemTextW(hwnd, HEADING, &c.heading);
                    let _ = SetDlgItemTextW(hwnd, TEXT, &c.text);
                    let _ = SetDlgItemTextW(hwnd, IDOK.0, &c.button);
                    // The heading a third larger than the dialog's font, at the dialog's scale
                    let font = HFONT(SendMessageW(hwnd, WM_GETFONT, None, None).0 as _);
                    let mut lf = LOGFONTW::default();
                    if GetObjectW(
                        font.into(),
                        std::mem::size_of::<LOGFONTW>() as i32,
                        Some(&mut lf as *mut _ as _),
                    ) != 0
                    {
                        lf.lfHeight = lf.lfHeight * 4 / 3;
                        c.font = CreateFontIndirectW(&lf);
                        SendDlgItemMessageW(
                            hwnd,
                            HEADING,
                            WM_SETFONT,
                            WPARAM(c.font.0 as usize),
                            LPARAM(0),
                        );
                    }
                    if c.can_pin {
                        let _ = CheckDlgButton(
                            hwnd,
                            PIN,
                            if c.pin { BST_CHECKED } else { BST_UNCHECKED },
                        );
                    } else {
                        let _ =
                            ShowWindow(GetDlgItem(Some(hwnd), PIN).unwrap_or_default(), SW_HIDE);
                        let _ = ShowWindow(
                            GetDlgItem(Some(hwnd), PIN_HINT).unwrap_or_default(),
                            SW_SHOW,
                        );
                    }
                    let _ = CheckDlgButton(
                        hwnd,
                        DEFAULTS,
                        if c.defaults {
                            BST_CHECKED
                        } else {
                            BST_UNCHECKED
                        },
                    );
                    let module = GetModuleHandleW(None).ok().map(HINSTANCE::from);
                    for (kind, metric) in [(ICON_BIG, SM_CXICON), (ICON_SMALL, SM_CXSMICON)] {
                        let size = GetSystemMetrics(metric);
                        if let Ok(icon) = LoadImageW(
                            module,
                            PCWSTR(1 as *const u16),
                            IMAGE_ICON,
                            size,
                            size,
                            LR_DEFAULTCOLOR,
                        ) {
                            SendMessageW(
                                hwnd,
                                WM_SETICON,
                                Some(WPARAM(kind as usize)),
                                Some(LPARAM(icon.0 as isize)),
                            );
                        }
                    }
                    1
                }
                WM_COMMAND => {
                    let id = (wparam.0 & 0xffff) as i32;
                    if id != IDOK.0 && id != IDCANCEL.0 {
                        return 0;
                    }
                    let c = &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Choices);
                    c.pin = c.can_pin && IsDlgButtonChecked(hwnd, PIN) == BST_CHECKED.0;
                    c.defaults = IsDlgButtonChecked(hwnd, DEFAULTS) == BST_CHECKED.0;
                    let _ = EndDialog(hwnd, id as isize);
                    1
                }
                _ => 0,
            }
        }
    }
}
