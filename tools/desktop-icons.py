#!/usr/bin/env python3
"""Regenerate document icons from each app's SVG (needs librsvg2-bin and ImageMagick)."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]

for app in ("quire", "ledger", "lectern"):
    source = (ROOT / "public" / app / "js/app.js").read_text()
    match = re.search(r"L\.icons\.app = function \(size\) \{.*?return `(.*?)`;", source, re.S)
    if not match:
        raise SystemExit(f"Cannot find {app}'s application icon")
    svg = match[1].replace("${sz}", "256").replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')
    # librsvg keeps the 16-unit SVG's strokes at the right scale; ImageMagick's internal SVG
    # renderer can lose the white letter/screen strokes when enlarging these icons.
    png = subprocess.run(["rsvg-convert"], input=svg.encode(), capture_output=True, check=True).stdout
    subprocess.run([
        "convert", "png:-", "-define", "icon:auto-resize=256,128,64,48,32,24,16",
        str(ROOT / "desktop/icons" / f"{app}.ico"),
    ], input=png, check=True)
    print(f"desktop/icons/{app}.ico")
