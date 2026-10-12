//! What the Windows installer (setup/) puts on the machine and `vibeoffice.exe -uninstall` takes off
//! again, kept in one place: the files in %LOCALAPPDATA%\VibeOffice, the shortcuts and the per-user
//! registrations (HKCU, no administrator rights). Both programs include this file; the lists are plain
//! data, tested on any platform (`cargo test`).
#![allow(dead_code)] // each program uses its half

/// The install folder's name in %LOCALAPPDATA%
pub const DIR: &str = "VibeOffice";
pub const EXE: &str = "vibeoffice.exe";
/// What the installer writes into the folder (it carries all three)
pub const FILES: [&str; 3] = [EXE, "WebView2Loader.dll", "LICENSE.txt"];
/// The shortcuts' file name, on the desktop and in the Start menu (and Windows' copy when pinned)
pub const SHORTCUT: &str = "VibeOffice.lnk";
/// The AppUserModelID of the app's process and of its shortcuts: what taskbar pinning goes by
pub const APP_ID: &str = "work.vibeoffice.desktop";
/// The app's data folders' name in %LOCALAPPDATA% (WebView2) and %APPDATA% (settings.json): Tauri's
/// identifier (tauri.conf.json)
pub const DATA_DIR: &str = "work.vibeoffice.desktop";
/// The name in RegisteredApplications, which Windows Settings' Default apps page goes by
pub const NAME: &str = "VibeOffice";
/// Arguments of the installed exe: the installer starts it with the user's choices; Apps & features
/// uninstalls with it
pub const PIN_ARG: &str = "-pin-taskbar";
pub const DEFAULTS_ARG: &str = "-choose-defaults";
pub const UNINSTALL_ARG: &str = "-uninstall";
/// Windows Settings at VibeOffice's Default apps page
pub const DEFAULT_APPS: &str = "ms-settings:defaultapps?registeredAppUser=VibeOffice";

pub struct FileType {
    pub ext: &'static str,
    pub progid: &'static str,
    pub name: &'static str,
    /// icon resource in vibeoffice.exe (build.rs): above the app icon's 32512, which must stay the
    /// exe's first (icon index 0: Explorer, the shortcuts, Apps & features)
    pub icon: i32,
}

pub const TYPES: [FileType; 3] = [
    FileType {
        ext: ".docx",
        progid: "VibeOffice.docx",
        name: "Quire Document",
        icon: 40101,
    },
    FileType {
        ext: ".xlsx",
        progid: "VibeOffice.xlsx",
        name: "Ledger Worksheet",
        icon: 40102,
    },
    FileType {
        ext: ".pptx",
        progid: "VibeOffice.pptx",
        name: "Lectern Presentation",
        icon: 40103,
    },
];

pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\VibeOffice";
const CLASSES: &str = r"Software\Classes";
const APPLICATION: &str = r"Software\Classes\Applications\vibeoffice.exe";
const VENDOR: &str = r"Software\VibeOffice";
const CAPABILITIES: &str = r"Software\VibeOffice\Capabilities";
const APP_PATHS: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths\vibeoffice.exe";
const REGISTERED: &str = r"Software\RegisteredApplications";

#[derive(Debug, Clone, PartialEq)]
pub enum Data {
    Str(String),
    Dword(u32),
}

/// A value under HKEY_CURRENT_USER; an empty name is the key's default value
#[derive(Debug, Clone, PartialEq)]
pub struct Value {
    pub key: String,
    pub name: String,
    pub data: Data,
}

/// What Apps & features shows about the installation
pub struct Install<'a> {
    pub dir: &'a str,
    pub version: &'a str,
    pub size_kb: u32,
    /// yyyymmdd
    pub date: &'a str,
}

/// Every registry value the installer writes. File types are offered (Open with, Default apps), never
/// taken: the extensions' own default value and UserChoice belong to Windows and the user.
pub fn values(install: &Install) -> Vec<Value> {
    let exe = format!(r"{}\{EXE}", install.dir);
    let open = format!(r#""{exe}" "%1""#);
    let icon = format!(r#""{exe}",0"#);
    let mut out = Vec::new();
    let mut put = |key: &str, name: &str, data: Data| {
        out.push(Value {
            key: key.to_string(),
            name: name.to_string(),
            data,
        })
    };
    let s = |v: &str| Data::Str(v.to_string());

    put(UNINSTALL_KEY, "DisplayName", s(NAME));
    put(UNINSTALL_KEY, "DisplayVersion", s(install.version));
    put(UNINSTALL_KEY, "Publisher", s(NAME));
    put(UNINSTALL_KEY, "DisplayIcon", s(&format!("{exe},0")));
    put(UNINSTALL_KEY, "InstallLocation", s(install.dir));
    put(
        UNINSTALL_KEY,
        "UninstallString",
        s(&format!(r#""{exe}" {UNINSTALL_ARG}"#)),
    );
    put(UNINSTALL_KEY, "URLInfoAbout", s("https://vibeoffice.work"));
    put(UNINSTALL_KEY, "InstallDate", s(install.date));
    put(UNINSTALL_KEY, "EstimatedSize", Data::Dword(install.size_kb));
    put(UNINSTALL_KEY, "NoModify", Data::Dword(1));
    put(UNINSTALL_KEY, "NoRepair", Data::Dword(1));

    for t in &TYPES {
        let progid = format!(r"{CLASSES}\{}", t.progid);
        put(&progid, "", s(t.name));
        put(&progid, "FriendlyTypeName", s(t.name));
        put(
            &format!(r"{progid}\DefaultIcon"),
            "",
            s(&format!(r#""{exe}",-{}"#, t.icon)),
        );
        put(&format!(r"{progid}\shell\open\command"), "", s(&open));
        put(
            &format!(r"{CLASSES}\{}\OpenWithProgids", t.ext),
            t.progid,
            s(""),
        );
        put(&format!(r"{APPLICATION}\SupportedTypes"), t.ext, s(""));
        put(
            &format!(r"{CAPABILITIES}\FileAssociations"),
            t.ext,
            s(t.progid),
        );
    }
    put(APPLICATION, "FriendlyAppName", s(NAME));
    put(&format!(r"{APPLICATION}\DefaultIcon"), "", s(&icon));
    put(&format!(r"{APPLICATION}\shell\open\command"), "", s(&open));

    put(CAPABILITIES, "ApplicationName", s(NAME));
    put(
        CAPABILITIES,
        "ApplicationDescription",
        s("Word processor, spreadsheet and presentations"),
    );
    put(CAPABILITIES, "ApplicationIcon", s(&icon));
    put(REGISTERED, NAME, s(CAPABILITIES));
    put(APP_PATHS, "", s(&exe));
    out
}

/// Keys that are VibeOffice's as a whole: uninstalling deletes them with everything under them
pub fn owned_keys() -> Vec<String> {
    let mut keys = vec![
        UNINSTALL_KEY.to_string(),
        APPLICATION.to_string(),
        VENDOR.to_string(),
        APP_PATHS.to_string(),
    ];
    keys.extend(TYPES.iter().map(|t| format!(r"{CLASSES}\{}", t.progid)));
    keys
}

/// VibeOffice's values in keys other programs share: uninstalling deletes just these
pub fn shared_values() -> Vec<(String, String)> {
    let mut values: Vec<_> = TYPES
        .iter()
        .map(|t| {
            (
                format!(r"{CLASSES}\{}\OpenWithProgids", t.ext),
                t.progid.to_string(),
            )
        })
        .collect();
    values.push((REGISTERED.to_string(), NAME.to_string()));
    values
}

#[cfg(windows)]
pub mod win {
    //! The registry, folders and shortcuts on Windows, for the installer and the uninstaller.
    use super::*;
    use std::path::{Path, PathBuf};
    use windows::{
        core::{Interface, GUID, HSTRING},
        Win32::{
            Foundation::ERROR_SUCCESS,
            System::{
                Com::{
                    CoCreateInstance, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ,
                },
                Registry::*,
            },
            UI::Shell::*,
        },
    };

    pub fn known_folder(id: &GUID) -> Option<PathBuf> {
        unsafe {
            let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let path = p.to_string().ok().map(PathBuf::from);
            CoTaskMemFree(Some(p.0 as _));
            path
        }
    }

    pub fn install_dir() -> Option<PathBuf> {
        known_folder(&FOLDERID_LocalAppData).map(|d| d.join(DIR))
    }

    /// The desktop and Start menu shortcuts
    pub fn shortcuts() -> Vec<PathBuf> {
        [FOLDERID_Desktop, FOLDERID_Programs]
            .iter()
            .filter_map(|id| known_folder(id))
            .map(|d| d.join(SHORTCUT))
            .collect()
    }

    /// Where Windows keeps the shortcut the user pinned to the taskbar
    pub fn pinned_shortcut() -> Option<PathBuf> {
        known_folder(&FOLDERID_RoamingAppData).map(|d| {
            d.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
                .join(SHORTCUT)
        })
    }

    /// The same file or folder, compared as Windows does (case and \\?\ aside)
    pub fn same_path(a: &Path, b: &Path) -> bool {
        let norm = |p: &Path| {
            std::fs::canonicalize(p)
                .unwrap_or_else(|_| p.to_path_buf())
                .to_string_lossy()
                .to_lowercase()
        };
        norm(a) == norm(b)
    }

    pub fn set(values: &[Value]) -> Result<(), String> {
        for v in values {
            let (kind, bytes) = match &v.data {
                Data::Str(s) => {
                    let wide: Vec<u16> = s.encode_utf16().chain([0]).collect();
                    (
                        REG_SZ,
                        wide.iter()
                            .flat_map(|w| w.to_le_bytes())
                            .collect::<Vec<u8>>(),
                    )
                }
                Data::Dword(d) => (REG_DWORD, d.to_le_bytes().to_vec()),
            };
            let err = unsafe {
                RegSetKeyValueW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(&v.key),
                    &HSTRING::from(&v.name),
                    kind.0,
                    Some(bytes.as_ptr() as _),
                    bytes.len() as u32,
                )
            };
            if err != ERROR_SUCCESS {
                return Err(format!(r"HKEY_CURRENT_USER\{}: error {}", v.key, err.0));
            }
        }
        Ok(())
    }

    /// Takes off what `values` wrote, and nothing of other programs'
    pub fn remove() {
        unsafe {
            for key in owned_keys() {
                let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(&key));
            }
            for (key, name) in shared_values() {
                let _ = RegDeleteKeyValueW(
                    HKEY_CURRENT_USER,
                    &HSTRING::from(&key),
                    &HSTRING::from(&name),
                );
            }
        }
    }

    pub fn get_string(key: &str, name: &str) -> Option<String> {
        let mut buf = [0u16; 512];
        let mut size = (buf.len() * 2) as u32;
        let err = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(key),
                &HSTRING::from(name),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as _),
                Some(&mut size),
            )
        };
        (err == ERROR_SUCCESS).then(|| {
            let len = (size as usize / 2).saturating_sub(1);
            String::from_utf16_lossy(&buf[..len])
        })
    }

    /// The installed version, as Apps & features shows it
    pub fn installed_version() -> Option<String> {
        get_string(UNINSTALL_KEY, "DisplayVersion")
    }

    /// Whether the user has chosen VibeOffice for .docx, .xlsx and .pptx in Windows (UserChoice, or
    /// UserChoiceLatest on newer Windows 11). Only read: Windows writes these, never an installer. With
    /// no choice made, Windows asks on a double-click even when VibeOffice is the only app offered.
    pub fn chosen_for_all_types() -> bool {
        TYPES.iter().all(|t| {
            let exts = format!(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\{}",
                t.ext
            );
            get_string(&format!(r"{exts}\UserChoiceLatest"), "ProgId")
                .or_else(|| get_string(&format!(r"{exts}\UserChoice"), "ProgId"))
                .is_some_and(|progid| progid == t.progid)
        })
    }

    /// One line of what the installer and the app's first start did, in %TEMP%\VibeOfficeSetup.log
    pub fn log(line: &str) {
        use std::io::Write;
        let path = std::env::temp_dir().join("VibeOfficeSetup.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{line}");
        }
    }

    /// Explorer drops its cached file types and icons
    pub fn notify_associations() {
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) }
    }

    /// The program a shortcut starts (COM must be initialised on this thread)
    pub fn shortcut_target(lnk: &Path) -> Option<PathBuf> {
        unsafe {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            link.cast::<IPersistFile>()
                .ok()?
                .Load(&HSTRING::from(lnk.as_os_str()), STGM_READ)
                .ok()?;
            let mut buf = [0u16; 1024];
            link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(PathBuf::from(String::from_utf16_lossy(&buf[..len])))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install() -> Vec<Value> {
        values(&Install {
            dir: r"C:\Users\Ann\AppData\Local\VibeOffice",
            version: "v2026.10.11-abcdef",
            size_kb: 7500,
            date: "20261011",
        })
    }

    fn under(key: &str, root: &str) -> bool {
        key.eq_ignore_ascii_case(root)
            || key
                .to_lowercase()
                .starts_with(&format!(r"{}\", root.to_lowercase()))
    }

    #[test]
    fn uninstalling_removes_every_value_installing_writes() {
        let shared = shared_values();
        for v in install() {
            let owned = owned_keys().iter().any(|k| under(&v.key, k));
            let one = shared.iter().any(|(k, n)| *k == v.key && *n == v.name);
            assert!(owned || one, "{v:?} would stay after uninstalling");
        }
    }

    #[test]
    fn file_types_are_offered_never_taken() {
        for v in install() {
            let key = v.key.to_lowercase();
            assert!(!key.contains("userchoice"), "{v:?}");
            for t in &TYPES {
                let ext = format!(r"software\classes\{}", t.ext);
                if under(&key, &ext) {
                    assert_eq!(key, format!(r"{ext}\openwithprogids"), "{v:?}");
                    assert_eq!(
                        (v.name.as_str(), &v.data),
                        (t.progid, &Data::Str(String::new()))
                    );
                }
            }
        }
        // Shared keys are never deleted whole
        for k in owned_keys() {
            assert!(
                !k.to_lowercase().contains(r"classes\.") && !k.ends_with("RegisteredApplications"),
                "{k}"
            );
        }
    }

    #[test]
    fn commands_quote_the_exe_and_the_file() {
        let all = install();
        let get = |key: &str, name: &str| {
            all.iter()
                .find(|v| v.key == key && v.name == name)
                .map(|v| v.data.clone())
                .unwrap()
        };
        let exe = r"C:\Users\Ann\AppData\Local\VibeOffice\vibeoffice.exe";
        assert_eq!(
            get(UNINSTALL_KEY, "UninstallString"),
            Data::Str(format!(r#""{exe}" -uninstall"#))
        );
        assert_eq!(
            get(r"Software\Classes\VibeOffice.docx\shell\open\command", ""),
            Data::Str(format!(r#""{exe}" "%1""#))
        );
        assert_eq!(
            get(r"Software\Classes\VibeOffice.xlsx\DefaultIcon", ""),
            Data::Str(format!(r#""{exe}",-40102"#))
        );
        assert_eq!(
            get(r"Software\RegisteredApplications", NAME),
            Data::Str(CAPABILITIES.to_string())
        );
        assert_eq!(
            get(
                r"Software\VibeOffice\Capabilities\FileAssociations",
                ".pptx"
            ),
            Data::Str("VibeOffice.pptx".into())
        );
    }
}
