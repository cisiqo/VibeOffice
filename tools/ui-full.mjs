// The whole of tests/ui/ (about 25 minutes), before a release (docs/testing.md): runs it and records the result for the
// content of public/ it ran on in .ui-full-tested.json (ignored by Git), which tools/ui-tested.sh checks when a release
// is made (tools/web-release.sh, ../cf-vibeoffice/sync-cf-pages.sh). Nothing is recorded if public/ changed during the
// run, or for a partial run (extra arguments go to node --test, e.g. --test-name-pattern).
//
//   node tools/ui-full.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sh = (cmd, ...args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const hash = () => sh(path.join(root, 'tools/ui-tested.sh'), '--hash');

const before = hash(), commit = sh('git', 'rev-parse', 'HEAD'), dirty = !!sh('git', 'status', '--porcelain', '--', 'public');
const files = fs.readdirSync(path.join(root, 'tests/ui')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join('tests/ui', f));
const started = Date.now();
let out = '';
const code = await new Promise((resolve) => {
  const p = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
  p.on('close', resolve);
});
const count = (k) => +((out.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) || [])[1] || 0);
/* each failing test with the tests it is part of ("parent › sub-test"), from the indented ▶ lines; only the innermost */
const failed = [], stack = [];
for (const line of out.slice(0, out.indexOf('✖ failing tests:') >>> 0).split('\n')) {
  const m = /^(\s*)(▶|✖) (.+?)(?: \([\d.]+ms\))?$/.exec(line);
  if (!m) continue;
  const depth = m[1].length;
  while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
  if (m[2] === '▶') stack.push({ depth, name: m[3] });
  else failed.push([...stack.map((x) => x.name), m[3]].join(' › '));
}
const failures = failed.filter((f) => !failed.some((g) => g !== f && g.startsWith(f + ' › ')));
const minutes = ((Date.now() - started) / 60000).toFixed(1);

if (process.argv.length > 2) {
  console.log(`\nA partial run (${process.argv.slice(2).join(' ')}): nothing recorded.`);
  process.exit(code ? 1 : 0);
}
if (hash() !== before) {
  console.error(`\npublic/ changed during the run (${minutes} min): nothing recorded; run it again on a settled public/.`);
  process.exit(1);
}
const record = { commit, dirty, public: before, date: new Date(started).toISOString(), minutes: +minutes,
  tests: count('tests'), pass: count('pass'), fail: count('fail'), todo: count('todo'), failures };
fs.writeFileSync(path.join(root, '.ui-full-tested.json'), JSON.stringify(record, null, 1) + '\n');
console.log(`\nRecorded in .ui-full-tested.json: ${record.pass} passed, ${record.fail} failed, ${record.todo} todo, on ${commit.slice(0, 7)}${dirty ? ' with uncommitted changes' : ''} (${minutes} min).`);
process.exit(code ? 1 : 0);
