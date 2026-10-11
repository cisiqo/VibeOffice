#!/usr/bin/env python3
"""Writes public/oss-licenses.html: the licenses of the open source works this repository is made with, as a
browser's credits page (About ▸ Open source licenses in the Start Center and every app).

  python3 tools/oss-licenses.py

The site: VibeOffice itself (LICENSE), the fonts (public/fonts/LICENSES.txt), the proofing lists
(public/common/dict/LICENSES.txt) and the ECMA-376 data in public/common/opc-order.js; their license files are
read by the page when an entry is opened. The desktop app: the crates desktop/Cargo.toml depends on directly
(not their own dependencies, nor build-only ones), on Windows (x86_64-pc-windows-gnu) or Linux
(x86_64-unknown-linux-gnu), with the license files from the crate's package (cargo metadata; the sources must be
downloaded, as after a build), and the DLLs that ship beside the exe (desktop/licenses/). Identical texts are kept
once. Run it again after changing a dependency. Standard library only."""
import hashlib, html, json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'oss-licenses.html')
TARGETS = {'windows': 'x86_64-pc-windows-gnu', 'linux': 'x86_64-unknown-linux-gnu'}
LICENSE_FILE = re.compile(r'^(licen[cs]e|copying|copyright|notice|unlicense)', re.I)

E = html.escape


def direct_crates(target):
    """{package id: package} of the crates the app depends on directly for a target (normal dependencies)"""
    out = subprocess.run(['cargo', 'metadata', '--format-version', '1', '--locked', '--filter-platform', target],
                         cwd=os.path.join(ROOT, 'desktop'), capture_output=True, text=True, check=True).stdout
    meta = json.loads(out)
    packages = {p['id']: p for p in meta['packages']}
    nodes = {n['id']: n for n in meta['resolve']['nodes']}
    root = meta['resolve']['root']
    return {d['pkg']: packages[d['pkg']] for d in nodes[root]['deps'] if any(k['kind'] is None for k in d['dep_kinds'])}


def license_texts(package):
    """the texts of the license files at the top of a crate's package (and in a LICENSES folder)"""
    folder = os.path.dirname(package['manifest_path'])
    names = []
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if os.path.isfile(path) and LICENSE_FILE.match(name) and not name.endswith('.rs'):
            names.append(path)
        elif os.path.isdir(path) and name.upper() == 'LICENSES':
            names += [os.path.join(path, n) for n in sorted(os.listdir(path)) if os.path.isfile(os.path.join(path, n))]
    out = []
    for path in names:
        with open(path, encoding='utf-8', errors='replace') as f:
            out.append((os.path.relpath(path, folder), f.read().strip()))
    return out


def main():
    texts = {}   # hash -> text, each kept once

    def keep(text):
        key = hashlib.sha1(text.encode()).hexdigest()[:12]
        texts[key] = text
        return key

    crates = {}   # (name, version) -> entry
    for platform, target in TARGETS.items():
        for package in direct_crates(target).values():
            key = (package['name'], package['version'])
            if key not in crates:
                files = license_texts(package)
                crates[key] = {
                    'name': package['name'], 'version': package['version'], 'license': package.get('license') or package.get('license_file') or '',
                    'url': package.get('repository') or package.get('homepage') or f"https://crates.io/crates/{package['name']}",
                    'texts': [keep(f'{name}\n\n{text}') for name, text in files], 'platforms': [],
                }
            crates[key]['platforms'].append(platform)

    with open(os.path.join(ROOT, 'LICENSE'), encoding='utf-8') as f:
        apache = keep(f.read().strip())
    with open(os.path.join(ROOT, 'desktop', 'licenses', 'WebView2Loader.txt'), encoding='utf-8') as f:
        webview2 = keep(f.read().strip())

    def work(name, lic, links, what, files='', texts_=(), src=''):
        head = f'<b>{E(name)}</b><span class="lic">{E(lic)}</span>' + ''.join(f'<a href="{E(u)}">{E(t)}</a>' for t, u in links)
        body = f'<p class="what">{what}</p>' if what else ''
        body += f'<p class="files">{E(files)}</p>' if files else ''
        if texts_ or src:
            attrs = f' data-texts="{" ".join(texts_)}"' if texts_ else f' data-src="{E(src)}"'
            body += f'<details{attrs}><summary>Show license</summary><pre></pre></details>'
        return f'<section class="work"><div class="head">{head}</div>{body}</section>\n'

    site = ''.join([
        work('VibeOffice.work', 'Apache License 2.0', [('github.com/tcchen2026/VibeOffice', 'https://github.com/tcchen2026/VibeOffice')],
             'Quire, Ledger, Lectern, the Start Center and everything they share, including the PDF writer, ZIP engine, metafile player, icons and clip art; and the desktop app around them.',
             texts_=[apache]),
        work('Carlito, Caladea and Gelasio fonts', 'SIL Open Font License 1.1', [('github.com/google/fonts', 'https://github.com/google/fonts')],
             'Metric-compatible stand-ins for Calibri, Cambria and Georgia, for computers that do not have them. Copyright 2013 The Carlito Project Authors; 2012 The Caladea Project Authors; 2022 The Gelasio Project Authors.',
             files='public/fonts/*.woff2', src='fonts/LICENSES.txt'),
        work('English word lists and thesaurus', 'SCOWL license; WordNet 2.1 license',
             [('wordlist.aspell.net', 'http://wordlist.aspell.net'), ('LibreOffice dictionaries', 'https://github.com/LibreOffice/dictionaries')],
             'The spelling word lists (US and UK English) from SCOWL and the English Speller Database by Kevin Atkinson, and the thesaurus from LibreOffice\'s English dictionary package, derived from WordNet (Princeton University).',
             files='public/common/dict/en_US.words, en_GB.words, en.thes', src='common/dict/LICENSES.txt'),
        work('Office Open XML (ECMA-376)', 'Ecma International', [('ecma-international.org', 'https://ecma-international.org/publications-and-standards/standards/ecma-376/')],
             'The order of elements in each part of a file, and the shape presets\' adjustment values, generated from the schemas and preset definitions of ECMA-376 Office Open XML File Formats, fifth edition (Parts 1 and 4).',
             files='public/common/opc-order.js'),
    ])

    names = {'windows': 'Windows', 'linux': 'Linux'}
    desktop = work('WebView2Loader.dll', 'BSD-3-Clause (Microsoft WebView2 SDK)', [('aka.ms/webview2', 'https://aka.ms/webview2')],
                   'Finds the system\'s WebView2 (Edge) runtime; ships beside vibeoffice.exe. Copyright Microsoft Corporation.', files='Windows', texts_=[webview2])
    missing = []
    for c in sorted(crates.values(), key=lambda c: (c['name'].lower(), c['version'])):
        if not c['texts']:
            missing.append(c['name'])
        where = ' and '.join(names[p] for p in TARGETS if p in c['platforms'])
        desktop += work(f"{c['name']} {c['version']}", c['license'], [(re.sub(r'^https?://', '', c['url']).rstrip('/'), c['url'])], '',
                        files=where + ('' if c['texts'] else ' · no license file in the package: see its repository'), texts_=c['texts'])

    page = TEMPLATE.replace('{{SITE}}', site).replace('{{DESKTOP}}', desktop).replace('{{COUNT}}', str(len(crates)))
    page = page.replace('{{TEXTS}}', json.dumps(texts, ensure_ascii=False).replace('</', '<\\/'))
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(page)
    print(f'{os.path.relpath(OUT, ROOT)}: {len(crates)} crates, {len(texts)} distinct texts, {len(page) // 1024} KB'
          + (f'; no license file: {", ".join(missing)}' if missing else ''))


TEMPLATE = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open source licenses - VibeOffice.work</title>
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<script>try{var d=document.documentElement,l=localStorage.getItem('vibeoffice.look')||'classic';d.dataset.look=l;d.dataset.layout=l==='paper2016'?'ribbon':'bars'}catch(e){}</script>
<link rel="stylesheet" href="common/looks.css">
<!-- Generated by tools/oss-licenses.py: edit that, not this page. -->
<style>
  /* the licenses of the works this repository is made with, as a browser's credits page: one entry per work,
     its license shown on request. Colours come from the look settings (common/looks.css). */
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--surface); color: var(--ink); font: 13px/1.5 var(--ui-font); }
  main { max-width: 860px; margin: 0 auto; padding: 24px 20px 40px; }
  h1 { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-size: 20px; }
  h1 img { width: 32px; height: 32px; }
  h2 { margin: 26px 0 4px; font-size: 15px; }
  .intro { margin: 0 0 14px; color: var(--muted); }
  .work { padding: 9px 0; border-top: 1px solid var(--chrome-line); }
  .work:last-child { border-bottom: 1px solid var(--chrome-line); }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
  .head b { font-size: 14px; }
  .head a { color: var(--pane-link); overflow-wrap: anywhere; }
  .lic, .files { color: var(--muted); }
  .what, .files { margin: 2px 0 0; }
  .files { font-size: 12px; }
  details { margin-top: 4px; }
  summary { cursor: pointer; color: var(--pane-link); width: max-content; }
  pre { margin: 6px 0 0; padding: 10px 12px; max-height: 420px; overflow: auto; white-space: pre-wrap; border: 1px solid var(--chrome-line);
    border-radius: 3px; background: var(--group-bg); font: 11px/1.45 ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
<main>
  <h1><img src="icons/icon.svg" alt="">Open source licenses</h1>
  <p class="intro">VibeOffice.work is open source, and it is made with the open source works below.</p>

  <h2>The site</h2>
  <p class="intro">The files of the web pages: the apps, the Start Center and what they share.</p>
{{SITE}}
  <h2>The desktop app</h2>
  <p class="intro">VibeOffice for Windows and Linux, around the same pages: the Rust crates it is built on (Tauri and the others it uses directly, each with its own dependencies) and the DLLs that ship with it.</p>
{{DESKTOP}}
</main>
<script type="application/json" id="texts">{{TEXTS}}</script>
<script>
  /* a license is filled in when its entry is opened: from this page's texts (each kept once), or from its own file */
  const TEXTS = JSON.parse(document.getElementById('texts').textContent);
  for (const d of document.querySelectorAll('details')) {
    d.addEventListener('toggle', async () => {
      const pre = d.querySelector('pre');
      if (!d.open || pre.textContent) return;
      if (d.dataset.texts) { pre.textContent = d.dataset.texts.split(' ').map((k) => TEXTS[k]).join('\\n\\n' + '-'.repeat(60) + '\\n\\n'); return; }
      try {
        const res = await fetch(d.dataset.src);
        pre.textContent = res.ok ? await res.text() : 'See ' + d.dataset.src + '.';
      } catch (e) { pre.textContent = 'See ' + d.dataset.src + '.'; }
    });
  }
</script>
</body>
</html>
'''

if __name__ == '__main__':
    sys.exit(main())
