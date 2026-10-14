// Check 1 of tests/ui/textmap.test.mjs (tests/lib/textmap.mjs) over real files: every editable text maps to the document.
//
//   node tools/textmap-corpus.mjs quire|lectern DIR N OUT.json [--hf]
//
// Opens N files of DIR (spread over the sorted list, under 3 MB) one after the other in one tab and sweeps each;
// --hf (Quire) sweeps the header or footer instead, opened for editing. OUT.json gets the counts per finding kind and
// up to four examples of each; the summary goes to stdout. Findings that are so by design: a caret inside a field
// snaps to its end (Lectern roundtrip on a slide number or date), "Picture" labels of missing pictures (orphan).
import fs from 'node:fs'; import path from 'node:path';
import { open, pause } from '../tests/lib/input.mjs';
import { SWEEP } from '../tests/lib/textmap.mjs';
const args = process.argv.slice(2), hf = args.includes('--hf');
const [app, dir, n, outFile] = args.filter((a) => a !== '--hf');
const ext = { quire: /\.docx$/i, lectern: /\.pptx$/i, ledger: /\.xlsx$/i }[app];
const all = fs.readdirSync(dir).filter((f) => ext.test(f)).sort().filter((f) => fs.statSync(path.join(dir, f)).size < 3e6);
const step = Math.max(1, Math.floor(all.length / +n)), files = all.filter((_, i) => i % step === 0).slice(0, +n);
const res = { files: 0, failedOpen: 0, nodes: 0, kinds: {}, byKind: {}, examples: [] };
let t = await open(app, { look: 'classic' });
for (const f of files) {
  try {
    const b64 = fs.readFileSync(path.join(dir, f)).toString('base64');
    await Promise.race([t.evaluate(`(async () => { const b = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)); await __corpusHooks.open(new File([b], ${JSON.stringify(f)})); await new Promise((r) => setTimeout(r, 700)); })()`), pause(20000).then(() => { throw new Error('timeout'); })]);
    let r = await t.evaluate(SWEEP[app]);
    if (app === 'quire' && hf) {
      const has = await t.evaluate(`!!document.querySelector('#pages .pg-hdr .p, #pages .pg-ftr .p')`);
      if (!has) continue;
      await t.evaluate(`(async () => { const h = document.querySelector('#pages .pg-hdr .p') ? 'hdr' : 'ftr'; L.app.editHeaderFooter(h, 0); await new Promise((r) => setTimeout(r, 500)); })()`);
      r = await t.evaluate(SWEEP[app]);
      await t.evaluate(`L.app.closeHeaderFooter && L.app.closeHeaderFooter()`);
    }
    res.files++; res.nodes += r.nodes;
    for (const [k, v] of Object.entries(r.kinds)) res.kinds[k] = (res.kinds[k] || 0) + v;
    const seen = new Set();
    for (const x of r.findings) {
      const key = x.kind + '/' + x.where;
      res.byKind[key] = res.byKind[key] || { nodes: 0, files: 0 }; res.byKind[key].nodes++;
      if (!seen.has(key)) { seen.add(key); res.byKind[key].files++; if (res.examples.filter((e) => e.key === key).length < 4) res.examples.push(Object.assign({ key, file: f }, x)); }
    }
  } catch (e) {
    res.failedOpen++;
    try { await t.close(); } catch {}
    t = await open(app, { look: 'classic' });
  }
}
await t.close();
fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ files: res.files, failedOpen: res.failedOpen, nodes: res.nodes, kinds: res.kinds, byKind: res.byKind }, null, 1));
