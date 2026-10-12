//! The installer carries the app built in ../ (build.sh builds that first; VO_PAYLOAD overrides where
//! it is) and its resources: the dialog, icon, manifest and version (setup.rc, compiled with windres).
use std::{env, path::PathBuf, process::Command};

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    println!("cargo:rerun-if-env-changed=VO_PAYLOAD");
    println!("cargo:rerun-if-env-changed=VO_VERSION");
    let payload = env::var_os("VO_PAYLOAD")
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.join("../target/x86_64-pc-windows-gnu/release"));
    let payload = payload
        .canonicalize()
        .expect("VO_PAYLOAD: build the app first (desktop/build.sh)");
    for file in ["vibeoffice.exe", "WebView2Loader.dll"] {
        let path = payload.join(file);
        assert!(
            path.is_file(),
            "{} is missing: build the app first (desktop/build.sh)",
            path.display()
        );
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rustc-env=VO_PAYLOAD={}", payload.display());

    // v2026.10.11-d2134d -> 2026,10,11,0 (dev: 0,0,0,0)
    let version = env::var("VO_VERSION").unwrap_or_else(|_| "dev".into());
    let numbers: Vec<&str> = version
        .trim_start_matches('v')
        .split(['.', '-'])
        .take(3)
        .collect();
    let file_version = match numbers.iter().all(|n| n.parse::<u16>().is_ok()) && numbers.len() == 3
    {
        true => format!("{},{},{},0", numbers[0], numbers[1], numbers[2]),
        false => "0,0,0,0".into(),
    };
    for file in ["setup.rc", "setup.manifest", "../icons/icon.ico"] {
        println!("cargo:rerun-if-changed={}", dir.join(file).display());
    }
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("setup-res.o");
    let status = Command::new("x86_64-w64-mingw32-windres")
        .current_dir(&dir)
        .arg(format!("-DVO_FILEVERSION={file_version}"))
        .arg(format!("-DVO_VERSION=\\\"{version}\\\""))
        .args(["-O", "coff", "-i", "setup.rc", "-o"])
        .arg(&out)
        .status()
        .expect("x86_64-w64-mingw32-windres (mingw-w64)");
    assert!(status.success(), "windres failed");
    println!("cargo:rustc-link-arg-bins={}", out.display());
}
