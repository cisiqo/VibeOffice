#!/usr/bin/env python3
"""The Windows installer end to end in Wine, run by hand (needs wine, Xvfb, xdotool, ImageMagick's import):
install from a folder holding only the installer, reinstall, uninstall; Wine's heap checks find no double free.

    python3 tests/desktop/setup-wine.py desktop/target/dist/VibeOfficeSetup.exe

It keeps its own Wine prefix in ./tmp/setup-wine (user folders inside it, no menu entries made) and leaves
screenshots of the dialogs there. Wine has neither WebView2 nor taskbar pinning: the installed app does not
get as far as a window, and the dialog shows the pinning hint instead of the checkbox.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SETUP = Path(sys.argv.pop(1)).resolve()
WORK = ROOT / "tmp" / "setup-wine"
PREFIX = WORK / "prefix"
DISPLAY = ":97"
ENV = dict(os.environ, WINEPREFIX=str(PREFIX), WINEDEBUG="-all,warn+heap", DISPLAY=DISPLAY,
           WINEDLLOVERRIDES="mscoree,mshtml=;winemenubuilder.exe=d")
USER = PREFIX / "drive_c" / "users" / os.environ.get("USER", "user")
DIR = USER / "AppData" / "Local" / "VibeOffice"
SHORTCUTS = [USER / "Desktop" / "VibeOffice.lnk",
             USER / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "VibeOffice.lnk"]
UNINSTALL = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\VibeOffice"
FILEEXTS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\"  # + ".docx"


def wine(*args, **kw):
    return subprocess.run(["wine", *args], env=ENV, capture_output=True, text=True, **kw)


def reg(key, name=None):
    """The value's data, or None"""
    out = wine("reg", "query", key, *(["/v", name] if name is not None else ["/ve"]))
    if out.returncode:
        return None
    for line in out.stdout.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) >= 2 and parts[1].startswith("REG_"):
            data = parts[2] if len(parts) > 2 else ""
            return None if data == "(value not set)" else data
    return None


def windows(title):
    out = subprocess.run(["xdotool", "search", "--name", f"^{title}$"], env=ENV, capture_output=True, text=True)
    return out.stdout.split()


def wait_window(title, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        if found := windows(title):
            time.sleep(1)  # let it paint
            return found[0]
        time.sleep(0.5)
    return None


def press(window, key):
    subprocess.run(["xdotool", "windowfocus", "--sync", window], env=ENV, capture_output=True)
    time.sleep(0.3)
    subprocess.run(["xdotool", "key", key], env=ENV, check=True)


def shot(name):
    subprocess.run(["import", "-window", "root", str(WORK / name)], env=ENV, check=True)


def run(*args, **kw):
    """A Wine process whose output (Wine's heap checks) goes to a file, read by heap_errors()"""
    out = open(WORK / f"wine-{len(list(WORK.glob('wine-*.log')))}.log", "w")
    return subprocess.Popen(["wine", *args], env=ENV, stdout=out, stderr=subprocess.STDOUT, **kw)


def heap_errors():
    """What Wine's heap checks found (a double free crashes on Windows; Wine only warns)"""
    return [line for log in WORK.glob("wine-*.log") for line in log.read_text(errors="replace").splitlines()
            if "warn:heap" in line or "err:heap" in line]


def stop_wine():
    subprocess.run(["wineserver", "-k"], env=ENV, capture_output=True)
    subprocess.run(["wineserver", "-w"], env=ENV, capture_output=True)


class Setup(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        WORK.mkdir(parents=True, exist_ok=True)
        cls.xvfb = subprocess.Popen(["Xvfb", DISPLAY, "-screen", "0", "1280x800x24"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        if not PREFIX.exists():
            subprocess.run(["wineboot", "-i"], env=ENV, capture_output=True, check=True)
            stop_wine()
        # The prefix's Desktop and so on link to the real ones: keep them inside it
        for d in USER.iterdir():
            if d.is_symlink():
                d.unlink()
                d.mkdir()
        stop_wine()
        if DIR.exists():
            shutil.rmtree(DIR)
        cls.downloads = WORK / "downloads"
        shutil.rmtree(cls.downloads, ignore_errors=True)
        cls.downloads.mkdir()
        shutil.copy(SETUP, cls.downloads / "VibeOfficeSetup.exe")
        for log in WORK.glob("wine-*.log"):
            log.unlink()
        # Another program's entry, which uninstalling must keep
        wine("reg", "add", r"HKCU\Software\Classes\.docx\OpenWithProgids", "/v", "Other.docx", "/t", "REG_SZ", "/d", "", "/f")

    @classmethod
    def tearDownClass(cls):
        stop_wine()
        cls.xvfb.terminate()
        cls.xvfb.wait()

    def test_install_start_again_uninstall(self):
        # Install: the dialog, Enter = Install
        setup = run("VibeOfficeSetup.exe", cwd=self.downloads)
        dialog = wait_window("VibeOffice Setup")
        self.assertIsNotNone(dialog, "no install dialog")
        shot("install-dialog.png")
        press(dialog, "Return")
        self.assertEqual(setup.wait(60), 0)
        time.sleep(2)
        stop_wine()  # the app it started (no WebView2 in Wine)

        log = (USER / "AppData" / "Local" / "Temp" / "VibeOfficeSetup.log").read_text()
        (WORK / "install.log").write_text(log)
        # No app chosen yet: "Open default app settings" is ticked, and the app is started to open them
        for step in ("wrote vibeoffice.exe", "registered Apps & features", "shortcut ", '"-choose-defaults"'):
            self.assertIn(step, log)
        for name in ("vibeoffice.exe", "WebView2Loader.dll", "LICENSE.txt"):
            self.assertTrue((DIR / name).is_file(), name)
        self.assertEqual(sorted(p.name for p in DIR.iterdir()), ["LICENSE.txt", "WebView2Loader.dll", "vibeoffice.exe"])
        for lnk in SHORTCUTS:
            self.assertTrue(lnk.is_file(), lnk)
        exe = r"C:\users\%s\AppData\Local\VibeOffice\vibeoffice.exe" % USER.name
        self.assertEqual(reg(UNINSTALL, "UninstallString"), f'"{exe}" -uninstall')
        self.assertEqual(reg(UNINSTALL, "DisplayName"), "VibeOffice")
        self.assertEqual(reg(r"HKCU\Software\Classes\VibeOffice.docx\shell\open\command"), f'"{exe}" "%1"')
        self.assertEqual(reg(r"HKCU\Software\Classes\VibeOffice.pptx\DefaultIcon"), f'"{exe}",-40103')
        self.assertEqual(reg(r"HKCU\Software\Classes\.xlsx\OpenWithProgids", "VibeOffice.xlsx"), "")
        self.assertEqual(reg(r"HKCU\Software\RegisteredApplications", "VibeOffice"), r"Software\VibeOffice\Capabilities")
        self.assertIsNone(reg(r"HKCU\Software\Classes\.docx"), "the extension's own default is the user's")

        # The same installer again: Reinstall, which puts back a missing shortcut. The user has chosen
        # VibeOffice for all three types meanwhile (Windows' UserChoice): the settings box is not ticked.
        SHORTCUTS[0].unlink()
        for ext in (".docx", ".xlsx", ".pptx"):
            wine("reg", "add", FILEEXTS + ext + r"\UserChoice", "/v", "ProgId", "/t", "REG_SZ", "/d", "VibeOffice" + ext, "/f")
        again = run("VibeOfficeSetup.exe", cwd=self.downloads)
        dialog = wait_window("VibeOffice Setup")
        self.assertIsNotNone(dialog, "no reinstall dialog")
        shot("reinstall-dialog.png")
        press(dialog, "Return")
        self.assertEqual(again.wait(60), 0)
        time.sleep(2)
        stop_wine()
        self.assertTrue(SHORTCUTS[0].is_file())
        log = (USER / "AppData" / "Local" / "Temp" / "VibeOfficeSetup.log").read_text()
        self.assertIn("VibeOffice chosen for all three types: true", log)
        self.assertIn("vibeoffice.exe [] (process", log, "no default app settings")
        for ext in (".docx", ".xlsx", ".pptx"):
            wine("reg", "delete", FILEEXTS + ext, "/f")

        # Uninstall, as Apps & features does: Enter = Uninstall, keeping the user's data
        uninstall = run(exe, "-uninstall")
        dialog = wait_window("VibeOffice")
        self.assertIsNotNone(dialog, "no uninstall dialog")
        shot("uninstall-dialog.png")
        press(dialog, "Return")
        self.assertEqual(uninstall.wait(60), 0)
        time.sleep(6)  # the folder goes once the uninstaller has ended
        self.assertFalse(DIR.exists(), sorted(p.name for p in DIR.iterdir()) if DIR.exists() else "")
        for lnk in SHORTCUTS:
            self.assertFalse(lnk.exists(), lnk)
        for key, name in [(UNINSTALL, "DisplayName"), (r"HKCU\Software\Classes\VibeOffice.docx", None),
                          (r"HKCU\Software\Classes\.docx\OpenWithProgids", "VibeOffice.docx"),
                          (r"HKCU\Software\RegisteredApplications", "VibeOffice"),
                          (r"HKCU\Software\VibeOffice\Capabilities", "ApplicationName")]:
            self.assertIsNone(reg(key, name), (key, name))
        self.assertEqual(reg(r"HKCU\Software\Classes\.docx\OpenWithProgids", "Other.docx"), "")
        self.assertEqual(heap_errors(), [])


if __name__ == "__main__":
    unittest.main()
