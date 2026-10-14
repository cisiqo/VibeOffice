// Code and data derived from other projects are credited: each file that says "Derived from <name> …" has an entry
// for <name> on the licenses page (public/oss-licenses.html, from tools/oss-licenses.py), with its license text, and
// each entry's files exist and say so; and the desktop app's part lists every crate that ships, none needing a
// copyleft licence (tools/oss-licenses.py --check, where cargo is installed):  node --test tests/licenses.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const page = fs.readFileSync(path.join(root, 'public/oss-licenses.html'), 'utf8');
const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const texts = JSON.parse(page.match(/<script type="application\/json" id="texts">([\s\S]*?)<\/script>/)[1].replace(/<\\\//g, '</'));
const derived = [...page.matchAll(/<section class="work derived">([\s\S]*?)<\/section>/g)].map(([, s]) => ({
  name: unescape(s.match(/<b>(.*?)<\/b>/)[1]),
  files: unescape((s.match(/<p class="files">(.*?)<\/p>/) || [, ''])[1]).split(', ').filter(Boolean),
  texts: ((s.match(/data-texts="([^"]*)"/) || [, ''])[1]).split(' ').filter(Boolean),
}));
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? (e.name === 'dict' || e.name === 'fonts' ? [] : sources(p)) : /\.(js|css|html)$/.test(e.name) && e.name !== 'oss-licenses.html' ? [p] : [];
});

test('each derived work on the licenses page has its files, its license text, and the files say where they come from', () => {
  assert.ok(derived.length >= 5, `${derived.length} derived works`);
  for (const w of derived) {
    assert.ok(w.files.length, `${w.name}: files`);
    assert.ok(w.texts.length && w.texts.every((k) => texts[k]), `${w.name}: license text`);
    for (const f of w.files) {
      assert.ok(fs.existsSync(path.join(root, f)), `${w.name}: ${f} exists`);
      assert.ok(fs.readFileSync(path.join(root, f), 'utf8').includes('erived from ' + w.name), `${f} says "Derived from ${w.name}"`);
    }
  }
});

test('every "Derived from …" in the site names a work on the licenses page', () => {
  const names = derived.map((w) => w.name);
  for (const file of sources(path.join(root, 'public'))) {
    for (const [line, rest] of fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => [...l.matchAll(/\b[Dd]erived from (.*)/g)].map((m) => [l, m[1]]))) {
      if (/^(it|them|the|a|an)\b/.test(rest)) continue;   // prose ("styles derived from it")
      const rel = path.relative(root, file);
      assert.ok(names.some((n) => rest.startsWith(n)), `${rel}: "${line.trim()}" names no work on the licenses page`);
      assert.ok(derived.find((w) => rest.startsWith(w.name)).files.includes(rel), `${rel} is listed under ${rest.split(' ')[0]}`);
    }
  }
});

test('the desktop app: the page lists every crate compiled into the app and its installer, and none needs copyleft', (t) => {
  try { execFileSync('cargo', ['--version'], { stdio: 'ignore' }); } catch { t.skip('no cargo'); return; }
  const out = execFileSync('python3', [path.join(root, 'tools/oss-licenses.py'), '--check'], { encoding: 'utf8' });
  assert.match(out, /lists the \d+ shipped crates; none needs a copyleft licence/);
});
