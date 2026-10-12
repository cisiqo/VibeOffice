fn main() {
    let mut windows =
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest"));
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Document icons for the file types the installer registers (src/installation.rs), numbered
        // above the app icon (32512): the exe's first icon is its own
        let dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
        for (id, app) in [(40101, "quire"), (40102, "ledger"), (40103, "lectern")] {
            let icon = dir.join("icons").join(format!("{app}.ico"));
            println!("cargo:rerun-if-changed={}", icon.display());
            windows = windows.append_rc_content(format!(
                "{id} ICON \"{}\"",
                icon.display().to_string().replace('\\', "/")
            ));
        }
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("tauri-build");
}
