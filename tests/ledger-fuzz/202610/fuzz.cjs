/* Ledger engine fuzz campaign, October 2026. All generators and cases live here.
 *
 *   node tests/ledger-fuzz/202610/fuzz.cjs
 *   node tests/ledger-fuzz/202610/fuzz.cjs --libreoffice
 *   node tests/ledger-fuzz/202610/fuzz.cjs --strict --libreoffice
 *   node tests/ledger-fuzz/202610/fuzz.cjs --libreoffice --seed=20261012 --count=32
 *   node tests/ledger-fuzz/202610/fuzz.cjs --libreoffice --modern
 *
 * KNOWN_FAIL cases assert the desired behavior and separately recognize the
 * exact current failure. They execute, never skip. Unexpected failures AND
 * unexpected passes exit 1. --strict also exits 1 for KNOWN_FAIL, for use when
 * fixing the engine. No production code or existing test is patched.
 *
 * Baseline: 8f48d5254bd1b892cc36f8eb7467ff9891d2c6bb, 2026-10-12.
 * Default priority: features available through Excel 2016. New coverage spans
 * aggregates, coercion, criteria, lookups/references, rounding, text, dates in
 * both date systems, finance, statistics, CSE arrays, and database functions.
 * NEW_FAILURES retains one minimized reproducer per cause; the round field
 * separates the original nine findings from subsequent discoveries.
 * The four old pre-2016 engine findings and harness-exit probe run ONCE each;
 * --count increases exploration and passing graph controls, never bug counts.
 * LAMBDA and dynamic spilling are deferred behind --modern, once each.
 * Arithmetic and acyclic graph expectations use independent integer arithmetic;
 * graph edits also compare against a new model and full calculation. History
 * follows app.js: model undo/redo, then ops.recalc(..., true).
 *
 * --libreoffice needs soffice and a Python with python3-uno (/usr/bin/python3;
 * override LEDGER_FUZZ_PYTHON / LEDGER_FUZZ_SOFFICE). The embedded helper writes
 * XLSX with Python's standard library, independently of Ledger's writer/reader,
 * opens it in an isolated headless Calc profile, forces calculateAll(), and
 * reads values/errors through UNO. It verifies every pinned expectation and
 * directly compares each generated formula's value AND result type. Broad
 * differential fuzzing only runs with --libreoffice; no Calc means unverified,
 * never PASS. Numeric comparisons use 1e-9 relative/absolute tolerance; pinned
 * failures use exact values unless an explicit absolute tolerance is supplied.
 * Positive/tail numeric controls can set absoluteTolerance: 0 so tiny nonzero
 * results cannot agree merely because both fall below an absolute error floor.
 * Modern equivalent-only checks are separate, not direct behavior evidence.
 *
 * Calc is not an Excel oracle for every corner. TYPE(formula-reference),
 * booleans in aggregate references, direct text-number coercion, fractional
 * SMALL ranks, and some error codes differ. Those are not counted as new bugs.
 * Empty literal XLSX strings can disappear on import: use ="" when testing a
 * real formula result. No automatic "all mismatches are known" allowlist.
 *
 * Reports, replay inputs, original XLSX and Calc's saved XLSX go in a unique
 * tmp/ledger-fuzz-202610/run-* directory (--out=DIR changes the parent). Each
 * finding records its seed, expected/actual values and source-file hashes.
 * This synthetic campaign is not the public corpus or an Excel acceptance run.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../../..');
const L = require('../../ledger/load.js');
require('../../../public/ledger/js/layout.js');
require('../../../public/ledger/js/ops.js');
const { model: M, calc: C, formula: F, ops: O } = L;
const BASELINE = '8f48d5254bd1b892cc36f8eb7467ff9891d2c6bb';

function options() {
  const o = { seed: 20261011, count: 32, strict: false, libreoffice: false, modern: false,
    out: path.join(ROOT, 'tmp/ledger-fuzz-202610') };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--strict') o.strict = true;
    else if (arg === '--libreoffice') o.libreoffice = true;
    else if (arg === '--modern') o.modern = true;
    else if (/^--(seed|count)=\d+$/.test(arg)) {
      const [k, v] = arg.slice(2).split('='); o[k] = Number(v);
    } else if (arg.startsWith('--out=')) o.out = path.resolve(arg.slice(6));
    else throw new Error('Unknown argument: ' + arg);
  }
  assert(Number.isInteger(o.seed) && o.seed >= 0 && o.seed <= 0xffffffff, 'seed must be uint32');
  assert(Number.isInteger(o.count) && o.count >= 1 && o.count <= 1000, 'count must be 1..1000');
  return o;
}
function random(seed) {
  let s = seed >>> 0;
  return (lo, hi) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ s >>> 15, s | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return lo + Math.floor(((t ^ t >>> 14) >>> 0) / 4294967296 * (hi - lo + 1));
  };
}
const clone = x => JSON.parse(JSON.stringify(x));
const plain = v => M.isErr(v) ? { error: v.e } : v == null ? null : v;
const book = () => ({ sheets: [{ name: 'Main', cells: {} }, { name: 'Data', cells: {} }], names: [] });
function put(b, s, a, value) {
  b.sheets[s].cells[a] = typeof value === 'string' && value.startsWith('=') ? { f: value.slice(1) } : { v: value };
}
function model(b) {
  const w = new M.Workbook();
  w.date1904 = !!b.date1904;
  Object.assign(w.calcPr, b.calc || {}); w.names = clone(b.names);
  for (const spec of b.sheets) {
    const sh = w.addSheet(spec.name);
    for (const [a, cell] of Object.entries(spec.cells)) {
      const p = F.parseCell(a); sh.put(p.r, p.c, { v: null, ...clone(cell) });
    }
    for (const [row, flags] of Object.entries(spec.rows || {})) Object.assign(sh.rowObj(Number(row) - 1), flags);
  }
  O.recalc(w, null, true);
  return w;
}
function enter(w, s, a, v) {
  const p = F.parseCell(a);
  O.tx(w, 'Fuzz edit', () => O.enter(w.sheets[s], p.r, p.c, String(v)));
}
function values(w, watch) {
  return watch.map(([s, a]) => { const p = F.parseCell(a); return plain(w.sheets[s].val(p.r, p.c)); });
}
function matches(a, b, tolerance = 0) {
  return a.length === b.length && a.every((v, i) => {
    if (typeof v === 'number' && typeof b[i] === 'number') return Number.isFinite(v) && Math.abs(v - b[i]) <= tolerance;
    return JSON.stringify(v) === JSON.stringify(b[i]);
  });
}

// Preserve raw UNO evidence; compare Excel error tokens from Calc's saved file.
// Logical results also get predicate assertions so 1 and TRUE cannot silently agree.
function oracleValue(v) {
  return v && typeof v === 'object' && v.error ? { error: v.xlsxError || v.error } : typeof v === 'boolean' ? Number(v) : v;
}
function closeValue(a, b, tolerance = 1e-9, absoluteTolerance = tolerance) {
  a = oracleValue(a); b = oracleValue(b);
  if (typeof a === 'number' && typeof b === 'number') return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(absoluteTolerance, tolerance * Math.max(Math.abs(a), Math.abs(b)));
  return JSON.stringify(a) === JSON.stringify(b);
}
function expression(r, depth) {
  if (!depth || r(0, 4) === 0) { const v = r(-20, 20); return { f: v < 0 ? '(' + v + ')' : String(v), v }; }
  const a = expression(r, depth - 1), b = expression(r, depth - 1);
  switch (r(0, 6)) {
    case 0: return { f: '(' + a.f + '+' + b.f + ')', v: a.v + b.v };
    case 1: return { f: '(' + a.f + '-' + b.f + ')', v: a.v - b.v };
    case 2: return { f: '(' + a.f + '*' + b.f + ')', v: a.v * b.v };
    case 3: return { f: 'MIN(' + a.f + ',' + b.f + ')', v: Math.min(a.v, b.v) };
    case 4: return { f: 'MAX(' + a.f + ',' + b.f + ')', v: Math.max(a.v, b.v) };
    case 5: return { f: 'ABS(' + a.f + ')', v: Math.abs(a.v) };
    default: return { f: 'IF(' + a.f + '>' + b.f + ',' + a.f + ',' + b.f + ')', v: Math.max(a.v, b.v) };
  }
}

// The ordinary DAG is a passing control, not an expected-failure allowlist.
function graphCase(seed) {
  const r = random(seed), b = book(), nodes = [], trace = [], watch = [];
  for (let i = 0; i < 26; i++) {
    const n = { s: i % 2, a: (i < 8 ? 'A' : 'C') + (1 + Math.floor(i / 2)) };
    if (i < 8) n.v = r(-20, 20);
    else Object.assign(n, { op: r(0, 3), left: r(0, i - 1), right: r(0, i - 1) });
    nodes.push(n); watch.push([n.s, n.a]);
  }
  const ref = n => b.sheets[n.s].name + '!' + n.a;
  function formula(n) {
    const a = ref(nodes[n.left]), z = ref(nodes[n.right]);
    return n.op === 0 ? a + '+' + z : n.op === 1 ? a + '-' + z : (n.op === 2 ? 'MIN' : 'MAX') + '(' + a + ',' + z + ')';
  }
  function expected() {
    const v = [];
    for (const n of nodes) v.push(n.v !== undefined ? n.v : n.op === 0 ? v[n.left] + v[n.right] : n.op === 1 ? v[n.left] - v[n.right] : n.op === 2 ? Math.min(v[n.left], v[n.right]) : Math.max(v[n.left], v[n.right]));
    return v;
  }
  nodes.forEach(n => put(b, n.s, n.a, n.v !== undefined ? n.v : '=' + formula(n)));
  const w = model(b);
  assert.deepEqual(values(w, watch), expected(), 'initial DAG');
  for (let step = 0; step < 12; step++) {
    const old = expected(), i = step % 3 === 2 ? r(8, 25) : r(0, 7), n = nodes[i];
    if (i < 8) n.v = r(-30, 30);
    else Object.assign(n, { op: r(0, 3), left: r(0, i - 1), right: r(0, i - 1) });
    const input = i < 8 ? n.v : '=' + formula(n);
    trace.push({ sheet: n.s, address: n.a, input });
    put(b, n.s, n.a, input); enter(w, n.s, n.a, input);
    assert.deepEqual(values(w, watch), expected(), 'incremental step ' + step + ' ' + JSON.stringify(trace));
    assert.deepEqual(values(model(b), watch), expected(), 'fresh full calculation step ' + step);
    w.undo.undo(); O.recalc(w, null, true);
    assert.deepEqual(values(w, watch), old, 'undo step ' + step);
    w.undo.redo(); O.recalc(w, null, true);
    assert.deepEqual(values(w, watch), expected(), 'redo step ' + step);
  }
  return { book: b, watch, expected: expected(), trace };
}

// Differential exploration uses only functions available by Excel 2016.
// Values, input ordering, date systems and boundaries vary; formula templates
// target different semantic paths rather than multiplying the old graph bugs.
function legacyBatch(seed) {
  const r = random(seed), b = book(), cases = [], watch = [];
  b.date1904 = !!(seed & 1);
  const add = (area, name, formula, array = false) => {
    const row = cases.length + 1, address = 'AA' + row, typeAddress = 'AB' + row;
    put(b, 0, address, '=' + formula);
    // Calc's TYPE(formula-reference) returns 8, unlike Excel. Use predicates.
    put(b, 0, typeAddress, '=IF(ISLOGICAL(' + address + '),4,IF(ISNUMBER(' + address + '),1,IF(ISTEXT(' + address + '),2,IF(ISERROR(' + address + '),16,0))))');
    if (array) b.sheets[0].cells[address].af = { r1: row - 1, c1: 26, r2: row - 1, c2: 26 };
    cases.push({ area, name, formula, address, array }); watch.push([0, address], [0, typeAddress]);
  };
  for (let i = 1; i <= 12; i++) {
    put(b, 0, 'A' + i, r(-15, 25)); put(b, 0, 'C' + i, r(1, 30));
    put(b, 0, 'D' + i, r(1, 30) / 4);
  }
  // Blank/zero criteria, booleans in aggregates and empty text are covered by
  // single minimized cases below, not rediscovered for every seed here.
  const mixed = [0, r(1, 9), -1, r(-9, -2), 'text', 'z', 'Alpha', 'alpha', 'a*b', 'a?b', 'b', '=NA()'];
  for (let i = mixed.length - 1; i > 0; i--) { const j = r(0, i); [mixed[i], mixed[j]] = [mixed[j], mixed[i]]; }
  mixed.forEach((v, i) => { if (v !== null) put(b, 0, 'B' + (i + 1), v); });
  // Keep MODE's no-mode error outside the oracle: Calc and Excel name it differently.
  put(b, 0, 'B13', 0); put(b, 0, 'B14', 0);
  ['zero', 'two', 'three', 'alpha', 'Alpha', 'a*b', 'a?b', 'z'].forEach((v, i) => put(b, 0, 'J' + (i + 1), v));
  // A separate mixed range has no error, so errors cannot mask coercion mistakes.
  [r(1, 9), String(r(1, 9)), 2, 0, '=""', 'text', null, '=""'].forEach((v, i) => { if (v !== null) put(b, 0, 'E' + (i + 1), v); });
  for (let i = 1; i <= 8; i++) {
    put(b, 0, 'G' + i, i * 3); put(b, 0, 'H' + i, r(10, 99));
    put(b, 0, 'I' + i, (9 - i) * 3);
    put(b, 1, F.cellName(0, i - 1), i * 3); put(b, 1, F.cellName(1, i - 1), r(10, 99));
  }
  for (const fn of ['SUM', 'PRODUCT', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTBLANK', 'AVERAGEA', 'MINA', 'MAXA', 'VAR', 'VARP', 'VARA', 'VARPA', 'STDEV', 'STDEVP', 'STDEVA', 'STDEVPA']) {
    add('aggregate', fn + '-numbers', fn + '(A1:A12)');
    add('aggregate', fn + '-mixed', fn + '(E1:E8)');
  }
  for (const fn of ['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MIN', 'MAX', 'AVERAGEA', 'MINA', 'MAXA']) {
    add('coercion', fn + '-direct', fn + '(TRUE,2,3)');
    add('coercion', fn + '-array', fn + '({2,"text",3})');
  }
  for (const criterion of ['0', '"0"', '"=0"', '"<>0"', '""', '"<>"', '"*"', '"a*"', '"a~*b"', '"a?b"', '"#N/A"']) {
    const allText = criterion === '"*"', range = allText ? 'J1:J8' : 'B1:B12', sums = allText ? 'C1:C8' : 'C1:C12';
    add('criteria', 'count-' + criterion, 'COUNTIF(' + range + ',' + criterion + ')');
    add('criteria', 'sum-' + criterion, 'SUMIF(' + range + ',' + criterion + ',' + sums + ')');
  }
  add('criteria', 'countifs', 'COUNTIFS(A1:A12,">=0",C1:C12,"<20")');
  add('criteria', 'sumifs', 'SUMIFS(D1:D12,A1:A12,">=0",C1:C12,"<20")');
  add('criteria', 'averageifs', 'AVERAGEIFS(D1:D12,A1:A12,">=0",C1:C12,"<20")');
  add('criteria', 'averageif', 'AVERAGEIF(A1:A12,">0",D1:D12)');
  const key = r(0, 27), exact = r(1, 8) * 3;
  for (const [name, f] of [
    ['vlookup-exact', 'VLOOKUP(' + exact + ',G1:H8,2,FALSE)'],
    ['vlookup-approx', 'VLOOKUP(' + key + ',G1:H8,2,TRUE)'],
    ['hlookup', 'HLOOKUP(' + exact + ',Data!A1:H2,2,FALSE)'],
    ['match-exact', 'MATCH(' + exact + ',G1:G8,0)'],
    ['match-ascending', 'MATCH(' + key + ',G1:G8,1)'],
    ['match-descending', 'MATCH(' + key + ',I1:I8,-1)'],
    ['lookup', 'LOOKUP(' + key + ',G1:G8,H1:H8)'],
    ['index', 'INDEX(G1:H8,' + r(1, 8) + ',2)'],
    ['index-column', 'SUM(INDEX(G1:H8,0,2))'],
    ['choose-range', 'SUM(CHOOSE(2,A1:A12,C1:C12))'],
    ['offset', 'SUM(OFFSET(A1,' + r(0, 5) + ',0,3,1))'],
    ['indirect', 'SUM(INDIRECT("A1:A12"))'],
    ['intersection', 'SUM(A1:C5 B3:D7)'],
    ['union', 'SUM((A1:A3,C1:C3))'],
  ]) add('reference', name, f);
  const n = r(-160, 160) / 8, d = r(-2, 3), m = r(1, 9) / 4;
  for (const f of ['ROUND', 'ROUNDUP', 'ROUNDDOWN', 'TRUNC']) add('rounding', f, f + '(' + n + ',' + d + ')');
  for (const f of ['MOD', 'MROUND', 'CEILING', 'FLOOR', 'CEILING.MATH', 'FLOOR.MATH', 'CEILING.PRECISE', 'FLOOR.PRECISE']) add('rounding', f, f + '(' + n + ',' + (f === 'MROUND' && n < 0 ? -m : m) + ')');
  for (const f of ['INT', 'SIGN', 'ABS', 'EVEN', 'ODD']) add('rounding', f, f + '(' + n + ')');
  for (const [name, f] of [
    ['concatenate', 'CONCATENATE("A",' + n + ',"B")'], ['left', 'LEFT("Abc def",' + r(0, 9) + ')'],
    ['right', 'RIGHT("Abc def",' + r(0, 9) + ')'], ['mid', 'MID("Abc def",' + r(1, 9) + ',3)'],
    ['trim', 'TRIM("  a   b  ")'], ['clean', 'CLEAN("a"&CHAR(10)&"b")'],
    ['substitute', 'SUBSTITUTE("abaaba","a","X",' + r(1, 5) + ')'], ['replace', 'REPLACE("abc",' + r(1, 5) + ',2,"X")'],
    ['search-wild', 'SEARCH("a?b","zzA*bcc")'], ['find', 'FIND("A","abA",' + r(1, 4) + ')'],
    ['proper', 'PROPER("a1b O\'NEIL")'], ['repeat', 'REPT("xy",' + r(0, 5) + ')'],
    ['fixed', 'FIXED(' + n + ',2,TRUE)'], ['text', 'TEXT(' + n + ',"0.00;(0.00)")'],
    ['numbervalue', 'NUMBERVALUE("1.234,50",",",".")'], ['value', 'VALUE("12.5%")'],
    ['exact', 'N(EXACT("Abc","abc"))'], ['error-type', 'ERROR.TYPE(NA())'],
    ['if-short-circuit', 'IF(TRUE,3,1/0)'], ['iferror', 'IFERROR(1/0,"fallback")'],
    ['ifna', 'IFNA(NA(),"fallback")'], ['choose-short-circuit', 'CHOOSE(2,1/0,7)'],
  ]) add('text-logical', name, f);
  const year = r(1996, 2030), month = r(1, 12), day = r(1, 28), span = r(1, 900);
  const start = 'DATE(' + [year, month, day].join(',') + ')', end = start + '+' + span;
  for (const fn of ['YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'ISOWEEKNUM']) add('date', fn, fn + '(' + start + ')');
  for (const type of [1, 2, 11, 12, 13, 14, 15, 16, 17, 21]) add('date', 'weeknum-' + type, 'WEEKNUM(' + start + ',' + type + ')');
  for (const basis of [0, 1, 2, 3, 4]) add('date', 'yearfrac-' + basis, 'YEARFRAC(' + start + ',' + end + ',' + basis + ')');
  for (const unit of ['Y', 'M', 'D', 'MD', 'YM', 'YD']) add('date', 'datedif-' + unit, 'DATEDIF(' + start + ',' + end + ',"' + unit + '")');
  for (const [name, f] of [
    ['eomonth', 'EOMONTH(' + start + ',' + r(-24, 24) + ')'], ['edate', 'EDATE(' + start + ',' + r(-24, 24) + ')'],
    ['days360-us', 'DAYS360(' + start + ',' + end + ',FALSE)'], ['days360-eu', 'DAYS360(' + start + ',' + end + ',TRUE)'],
    ['networkdays', 'NETWORKDAYS(' + start + ',' + end + ')'], ['networkdays-intl', 'NETWORKDAYS.INTL(' + start + ',' + end + ',"0011000")'],
    ['workday', 'WORKDAY(' + start + ',' + r(-50, 50) + ')'], ['workday-intl', 'WORKDAY.INTL(' + start + ',' + r(-50, 50) + ',11)'],
    ['time-overflow', 'TIME(' + r(24, 90) + ',90,90)'],
  ]) add('date', name, f);
  const rate = r(1, 12) / 100, periods = r(2, 30), present = r(100, 5000);
  for (const [name, f] of [
    ['pmt', 'PMT(' + [rate, periods, present].join(',') + ')'], ['pv', 'PV(' + [rate, periods, -100].join(',') + ')'],
    ['fv', 'FV(' + [rate, periods, -100, -present, 1].join(',') + ')'],
    ['nper', 'NPER(' + [rate, -100, 500].join(',') + ')'], ['ipmt', 'IPMT(' + [rate, 1, periods, present].join(',') + ')'],
    ['ppmt', 'PPMT(' + [rate, 2, periods, present, 0, 1].join(',') + ')'], ['npv', 'NPV(' + rate + ',A1:A12)'],
    ['irr', 'IRR({-1000;300;400;500})'], ['mirr', 'MIRR({-1000;300;400;500},0.1,0.12)'],
    ['rate', 'RATE(' + periods + ',PMT(' + rate + ',' + periods + ',' + present + '),' + present + ')'],
    ['sln', 'SLN(1000,100,' + periods + ')'], ['syd', 'SYD(1000,100,' + periods + ',1)'],
    ['ddb', 'DDB(1000,100,' + periods + ',2)'], ['db', 'DB(1000,100,' + periods + ',2)'],
  ]) add('finance', name, f);
  for (const [name, f] of [
    ['median', 'MEDIAN(A1:A12)'], ['rank', 'RANK(A1,A1:A12,0)'], ['percentile', 'PERCENTILE(A1:A12,0.25)'],
    ['quartile', 'QUARTILE(A1:A12,3)'], ['large', 'LARGE(A1:A12,3)'], ['small', 'SMALL(A1:A12,3)'],
    ['correl', 'CORREL(A1:A12,C1:C12)'], ['slope', 'SLOPE(A1:A12,C1:C12)'], ['intercept', 'INTERCEPT(A1:A12,C1:C12)'],
    ['forecast', 'FORECAST(5,A1:A12,C1:C12)'], ['geomean', 'GEOMEAN(C1:C12)'], ['harmean', 'HARMEAN(C1:C12)'],
    ['skew', 'SKEW(A1:A12)'], ['kurt', 'KURT(A1:A12)'], ['norm', 'NORM.DIST(' + n + ',0,1,TRUE)'],
    ['norm-inv', 'NORM.S.INV(' + r(1, 99) / 100 + ')'], ['binom', 'BINOM.DIST(3,10,0.4,TRUE)'],
    ['poisson', 'POISSON.DIST(3,4,TRUE)'], ['t-dist', 'T.DIST(1.5,10,TRUE)'],
  ]) add('statistics', name, f);
  for (const [name, f, array] of [
    ['sumproduct', 'SUMPRODUCT(A1:A12,C1:C12)', false], ['sumproduct-mask', 'SUMPRODUCT((A1:A12>0)*C1:C12)', false],
    ['sum-if-cse', 'SUM(IF(A1:A12>0,C1:C12,0))', true], ['matrix-multiply', 'SUM(MMULT({1,2;3,4},{5;6}))', true],
    ['matrix-inverse', 'SUM(MINVERSE({2,1;1,2}))', true], ['transpose', 'SUM(TRANSPOSE(A1:A12))', true],
    ['frequency', 'SUM(FREQUENCY(A1:A12,{-5;0;5}))', true], ['linest', 'SUM(LINEST(A1:A12,C1:C12))', true],
    ['array-criteria', 'SUM(COUNTIF(B1:B12,{"a*","0"}))', true],
  ]) add('legacy-array', name, f, array);
  for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) add('subtotal', String(code), 'SUBTOTAL(' + code + ',A1:A12)');
  for (const code of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) add('aggregate-options', String(code), 'AGGREGATE(' + code + ',6,B1:B' + (code === 13 ? 14 : 12) + ')');
  for (const code of [14, 15, 16, 17, 18, 19]) add('aggregate-array', String(code), 'AGGREGATE(' + code + ',6,A1:A12,' + (code < 16 || code === 17 || code === 19 ? 2 : 0.5) + ')');
  // Database errors, optional fields, duplicate headers and computed criteria.
  put(b, 1, 'J1', 'Group'); put(b, 1, 'K1', 'Value');
  for (let i = 2; i <= 7; i++) { put(b, 1, 'J' + i, i % 2 ? 'pear' : 'apple'); put(b, 1, 'K' + i, r(1, 9)); }
  put(b, 1, 'M1', 'Group'); put(b, 1, 'M2', 'apple');
  put(b, 1, 'N1', 'Group'); put(b, 1, 'N2', 'pear');
  for (const fn of ['DSUM', 'DAVERAGE', 'DCOUNT', 'DCOUNTA', 'DMAX', 'DMIN', 'DPRODUCT', 'DSTDEV', 'DSTDEVP', 'DVAR', 'DVARP']) {
    for (const crit of ['M', 'N']) add('database', fn + '-' + crit, fn + '(Data!J1:K7,"Value",Data!' + crit + '1:' + crit + '2)');
  }
  add('database', 'DCOUNTA-missing-field', 'DCOUNTA(Data!J1:K7,,Data!M1:M2)');
  const febYear = r(1996, 2030), febEnd = 'DATE(' + febYear + ',3,0)', nextMarch = 'DATE(' + (febYear + 1) + ',3,1)';
  for (const unit of ['MD', 'YD', 'M', 'YM']) add('date-boundary', 'datedif-' + unit, 'DATEDIF(' + febEnd + ',' + nextMarch + ',"' + unit + '")');
  for (const basis of [0, 1, 2, 3, 4]) add('date-boundary', 'yearfrac-' + basis, 'YEARFRAC(DATE(' + febYear + ',1,31),' + febEnd + ',' + basis + ')');
  add('date-boundary', 'days360-end-feb', 'DAYS360(DATE(' + febYear + ',1,31),' + febEnd + ')');
  for (const name of ['CEILING.MATH', 'FLOOR.MATH']) for (const mode of [-1, 0, 1]) add('rounding-boundary', name + '-' + mode, name + '(' + -Math.abs(n) + ',' + -m + ',' + mode + ')');
  for (const [name, formula, array] of [
    ['vlookup-blank-key', 'VLOOKUP(Z1,{0,2;1,3},2,FALSE)'],
    ['match-blank-key', 'MATCH(Z1,{0;1;2},0)'],
    ['lookup-short-result', 'LOOKUP(2,{1;2;3},{10})'],
    ['match-duplicate-desc', 'MATCH(3,{5;3;3;1},-1)'],
    ['isref-index', 'N(ISREF(INDEX(A1:C12,2,2)))'],
    ['isref-indirect', 'N(ISREF(INDIRECT("A1")))'],
    ['and-error', 'AND(FALSE,NA())'], ['or-error', 'OR(TRUE,NA())'],
    ['array-iferror', 'SUM(IFERROR(B1:B12,5))', true],
    // Calc cannot import errors inside inline arrays (Err:539); use references.
    ['sumproduct-error-mask', 'SUMPRODUCT(A1:A12,B1:B12)'],
    ['mmult-text', 'SUM(MMULT({1,"a";3,4},{1;2}))', true],
    ['linest-stats', 'SUM(LINEST({2;5;6;9},{1;2;3;4},TRUE,TRUE))', true],
    ['linest-multivariate', 'SUM(LINEST({4;8;14;22},{1,1;2,4;3,9;4,16}))', true],
    ['trend-multivariate', 'SUM(TREND({4;8;14;22},{1,1;2,4;3,9;4,16},{5,25;6,36}))', true],
    ['frequency-text', 'SUM(FREQUENCY({1;2;3;4},{"a";2}))', true],
    ['large-fractional-k', 'LARGE({1;2;3},1.5)'],
    ['percentile-exc', 'PERCENTILE.EXC({1;2;3;4},0.2)'],
    ['rank-avg', 'RANK.AVG(2,{1;2;2;4},1)'],
    ['percent-rank', 'PERCENTRANK.INC({1;2;2;4},2.5,4)'],
    ['sumx2py2-text', 'SUMX2PY2({1;"x";3},{4;5;6})'],
    ['covariance-text', 'COVARIANCE.P({1;"x";3},{4;5;6})'],
    ['devsq-constant', 'DEVSQ({1;1;1})'],
    ['logest', 'SUM(LOGEST({2;4;8;16},{1;2;3;4}))', true],
    ['irr-negative', 'IRR({-100;30;30})'],
    ['xnpv', 'XNPV(0.1,{-100;60;60},{40000;40100;40400})'],
    ['xirr', 'XIRR({-100;60;60},{40000;40100;40400})'],
    ['coupdays-feb', 'COUPDAYS(DATE(2016,2,28),DATE(2020,8,31),2,1)'],
    ['coupncd-feb', 'COUPNCD(DATE(2016,2,28),DATE(2020,8,31),2,0)'],
    ['coupdaysnc-feb', 'COUPDAYSNC(DATE(2016,2,28),DATE(2020,8,31),2,0)'],
    ['price', 'PRICE(DATE(2016,2,28),DATE(2020,8,31),0.05,0.06,100,2,0)'],
    ['convert-area', 'CONVERT(1,"cm2","m2")'], ['complex-power', 'IMAGINARY(IMPOWER("-1",0.5))'],
    ['hex-negative', 'HEX2DEC("FFFFFFFFFF")'], ['base-negative', 'DEC2BIN(-1)'],
    ['numbervalue-percent', 'NUMBERVALUE("50%%")'],
    ['substitute-empty', 'SUBSTITUTE("abc","","x")'], ['replace-past-end', 'REPLACE("abc",9,2,"x")'],
  ]) add('edge', name, formula, !!array);
  const actual = values(model(b), watch);
  return { id: 'legacy-' + seed, seed, book: b, cases, watch, actual, differential: true };
}

// Second exploration pass: engineering, numerical boundaries, international
// text and legacy CSE shape/coercion. Like legacyBatch, every value is paired
// with a result-type assertion; complex outputs use components, not formatting.
// Failed domains were minimized into round 2 below, not repeated per seed.
// Do not turn these Calc differences into Ledger bugs: CONVERT uses different
// constants for lbm/atm; BESSELK has coarser reference accuracy; collinear LINEST
// and extreme MINVERSE have different error behavior; zero-success HYPGEOMDIST
// is allowed in Calc but explicitly rejected by Excel's documented domain:
// https://support.microsoft.com/en-us/excel/functions/hypgeom-dist-function
// CORREL at 1e80 returns zero in BOTH engines, so agreement is not correctness.
function boundaryBatch(seed) {
  const r = random(seed), b = book(), cases = [], watch = [];
  const add = (area, name, formula, array = false, absoluteTolerance = 1e-9) => {
    const row = cases.length + 1, address = 'AA' + row, typeAddress = 'AB' + row;
    put(b, 0, address, '=' + formula);
    put(b, 0, typeAddress, '=IF(ISLOGICAL(' + address + '),4,IF(ISNUMBER(' + address + '),1,IF(ISTEXT(' + address + '),2,IF(ISERROR(' + address + '),16,0))))');
    if (array) b.sheets[0].cells[address].af = { r1: row - 1, c1: 26, r2: row - 1, c2: 26 };
    cases.push({ area, name, formula, address, array, absoluteTolerance }); watch.push([0, address], [0, typeAddress]);
  };
  [2, 3, 5, 8].forEach((v, i) => put(b, 0, 'A' + (i + 1), v));
  ['a', 'b', 'c', 'd'].forEach((v, i) => put(b, 0, 'B' + (i + 1), v));
  [true, false, true, false].forEach((v, i) => put(b, 0, 'C' + (i + 1), v));
  const a = r(4, 9), c = r(1, 9), n = r(1, 15), z = '"' + a + '+' + c + 'i"';
  for (const [name, formula] of [
    ['roundtrip-real', 'IMREAL(COMPLEX(' + a + ',' + c + '))'],
    ['roundtrip-imaginary', 'IMAGINARY(COMPLEX(' + a + ',' + c + '))'],
    ['modulus', 'IMABS(' + z + ')'], ['argument', 'IMARGUMENT(' + z + ')'],
  ]) add('complex', name, formula);
  for (const fn of ['IMCONJUGATE', 'IMEXP', 'IMLN', 'IMLOG10', 'IMLOG2', 'IMSQRT', 'IMSIN', 'IMCOS', 'IMTAN', 'IMSINH', 'IMCOSH', 'IMCOT', 'IMSEC', 'IMCSC', 'IMSECH', 'IMCSCH']) {
    for (const part of ['IMREAL', 'IMAGINARY']) add('complex', fn + '-' + part, part + '(' + fn + '(' + z + '))');
  }
  for (const fn of ['IMSUM', 'IMPRODUCT', 'IMDIV', 'IMSUB']) for (const part of ['IMREAL', 'IMAGINARY']) {
    // Fractional real component prevents an accidentally pure-imaginary
    // intermediate from repeating the already-pinned parseCx failure.
    add('complex', fn + '-' + part, part + '(' + fn + '(' + z + ',"3.25-2i"))');
  }
  for (const fn of ['BESSELJ', 'BESSELI', 'BESSELY']) {
    add('bessel', fn + '-ordinary', fn + '(' + a + ',' + n + ')', false, 0);
  }
  const large = r(171, 300), choose = r(2, 5);
  for (const [name, formula] of [
    ['multinomial-small', 'MULTINOMIAL(' + a + ',' + c + ')'],
    ['combin-large', 'COMBIN(' + large + ',' + choose + ')'], ['combin-symmetric', 'COMBIN(' + large + ',' + (large - choose) + ')'],
    ['gcd', 'GCD(' + a * 12 + ',' + c * 12 + ')'], ['lcm', 'LCM(' + a * 12 + ',' + c * 12 + ')'],
    ['base-padding', 'BASE(' + a + ',2,' + r(4, 12) + ')'], ['decimal', 'DECIMAL("Z' + a + '",36)'],
  ]) add('integer', name, formula);
  for (const base of ['BIN', 'OCT', 'HEX']) {
    add('bases', base + '-roundtrip', base + '2DEC(DEC2' + base + '(' + r(-500, 500) + '))');
    add('bases', base + '-places', 'DEC2' + base + '(' + a + ',8)');
  }
  for (const fn of ['BITAND', 'BITOR', 'BITXOR']) add('bits', fn, fn + '(' + r(0, 1000000) + ',' + r(0, 1000000) + ')');
  for (const fn of ['BITLSHIFT', 'BITRSHIFT']) add('bits', fn, fn + '(' + r(0, 10000) + ',' + r(-8, 8) + ')');
  for (const [from, to] of [['C', 'F'], ['F', 'K'], ['cm3', 'l'], ['Mibit', 'byte'], ['kibyte', 'bit'], ['cm2', 'm2'], ['km/hr', 'mph']]) {
    add('convert', from + '-' + to, 'CONVERT(' + n + ',"' + from + '","' + to + '")');
  }
  for (const [name, formula] of [
    ['asc-latin', 'ASC("ＡＢ１２")'],
    ['proper-latin', 'PROPER("déjà VU 2fast")'], ['baht-fraction', 'BAHTTEXT(0.5)'],
    ['baht-zero', 'BAHTTEXT(0)'], ['baht-number', 'BAHTTEXT(' + n + '.25)'],
    ['unicode', 'UNICODE(UNICHAR(' + (945 + n) + '))'], ['unichar', 'UNICHAR(' + (945 + n) + ')'],
    ['dollar-decimals', 'DOLLAR(0.0001,4)'], ['numbervalue-group', 'NUMBERVALUE("1.234,50",",",".")'],
  ]) add('international-text', name, formula);
  for (const rate of [0, r(1, 10) / 1000, -r(1, 10) / 1000]) for (const [name, formula] of [
    ['pv', 'PV(' + rate + ',' + (n + 12) + ',' + -a * 100 + ',0)'], ['fv', 'FV(' + rate + ',' + (n + 12) + ',' + -a * 100 + ',0)'],
    ['pmt', 'PMT(' + rate + ',' + (n + 12) + ',' + a * 1000 + ')'],
  ]) add('annuity', name + '-' + rate, formula);
  for (const [name, formula] of [
    ['n-inline-array', 'SUM(N({' + a + ';' + c + '}))'],
    ['t-inline-array', 'SUM(LEN(T({"alpha";"beta"})))'],
    ['trend-row', 'INDEX(TREND({2,4,6},{1,2,3},{' + a + ',' + (a + 1) + '}),1,2)'],
    ['growth-row', 'INDEX(GROWTH({2,4,8},{1,2,3},{' + a + ',' + (a + 1) + '}),1,2)'],
    ['minverse-scaled', '1e-100*INDEX(MINVERSE({1e-100,0;0,1e-100}),1,1)'],
    ['mdeterm-scaled', '1e100*MDETERM({1e-100,0;0,' + a + '})'],
  ]) add('legacy-array-boundary', name, formula, true);
  const trials = r(100, 1000), successes = Math.floor(trials / 2), p = r(1, 99) / 100;
  for (const [name, formula] of [
    ['binomial-large', 'BINOMDIST(' + successes + ',' + trials + ',0.5,FALSE)'],
    ['binomial-tail', 'BINOMDIST(' + (trials - 1) + ',' + trials + ',0.999,FALSE)'],
    ['poisson-large', 'POISSON(' + trials + ',' + trials + ',FALSE)'],
    ['negbinomial-large', 'NEGBINOMDIST(' + successes + ',' + successes + ',0.5)'],
    ['hypgeom-large', 'HYPGEOMDIST(' + a + ',' + 2 * a + ',' + 2 * a + ',' + 4 * a + ')'],
    ['normal-tail', 'NORMINV(1e-' + r(10, 100) + ',0,1)'],
    ['chi-central', 'CHIINV(' + p + ',' + n + ')'],
    ['gamma-large', 'GAMMADIST(' + trials + ',' + trials + ',1,FALSE)'],
    ['gamma-inverse', 'GAMMAINV(' + p + ',' + a + ',1)'],
    ['beta-inverse', 'BETAINV(' + p + ',' + a + ',' + c + ')'],
    ['geomean-large', 'GEOMEAN({' + a + 'e200;' + c + 'e200})'],
    ['harmean-small', 'HARMEAN({' + a + 'e-200;' + c + 'e-200})'],
    ['correl-scaled', 'CORREL({1e30;2e30;3e30},{3e30;1e30;2e30})'],
    ['gamma-half-integer', 'GAMMA(' + (a + 0.5) + ')'], ['fisherinv', 'FISHERINV(' + a / 10 + ')'],
    ['beta-zero-endpoint', 'BETADIST(0,1,' + a + ')'],
    ['binomial-zero-trials', 'BINOMDIST(0,0,0.5,FALSE)'],
    ['gamma-zero-point', 'GAMMADIST(0,1,2,FALSE)'],
    ['weibull-zero-point', 'WEIBULL(0,1,2,FALSE)'],
  ]) add('statistics-boundary', name, formula, false, 0);
  const actual = values(model(b), watch);
  return { id: 'boundary-' + seed, seed, book: b, cases, watch, actual, differential: true };
}

const FAMILIES = {
  'named-lambda': 'The graph does not expand cell references inside a named LAMBDA call.',
  'qualified-name': 'Precedents ignore the sheet qualifier when resolving a local defined name.',
  'index-range': 'Precedents omit cells between a reference and an INDEX-produced range endpoint.',
  'sumif-shape': 'Precedents omit the implicit expansion of SUMIF sum_range from its top-left cell.',
  'dynamic-spill': 'New array-valued formulas are reduced to the top-left value without spilling.',
  'iteration': 'Calculation reads the previous circular value once instead of iterating to convergence.',
};
function knownCase(family, seed) {
  const r = random(seed), b = book(), x = r(1, 20), delta = r(1, 20), add = r(1, 9);
  let watch, expected, knownActual, edit, tolerance = 0, equivalent = null;
  if (family === 'named-lambda' || family === 'qualified-name') {
    const s = family === 'named-lambda' ? 0 : 1;
    put(b, s, 'A1', x);
    if (!s) {
      b.names.push({ name: 'PlusBase', ref: 'LAMBDA(x,x+Main!$A$1)', scope: null });
      put(b, 0, 'B1', '=PlusBase(' + add + ')');
      equivalent = { cell: [0, 'B1'], formula: 'Main!$A$1+' + add,
        limitation: 'Expanded body verifies the number, not LAMBDA or its dependency tracking.' };
    } else {
      b.names.push({ name: 'Source', ref: 'Data!$A$1', scope: 1 });
      put(b, 0, 'B1', '=Data!Source+' + add);
    }
    watch = [[0, 'B1']]; knownActual = [x + add]; expected = [x + delta + add]; edit = [s, 'A1', x + delta];
  } else if (family === 'index-range') {
    const h = r(3, 8), width = r(3, 6); let sum = 0;
    for (let row = 0; row < h; row++) for (let c = 0; c < width; c++) { const v = r(-10, 10); put(b, 0, F.cellName(row, c), v); sum += v; }
    const last = F.colName(width - 1), target = F.cellName(r(1, h - 1), r(1, width - 2));
    put(b, 0, 'H1', '=SUM(A1:INDEX(' + last + '1:' + last + h + ',' + h + '))');
    watch = [[0, 'H1']]; knownActual = [sum]; expected = [sum + delta]; edit = [0, target, b.sheets[0].cells[target].v + delta];
  } else if (family === 'sumif-shape') {
    const h = r(3, 9), target = r(2, h); let sum = 0;
    for (let row = 1; row <= h; row++) {
      const criterion = row === target || r(0, 1) ? 1 : -1, v = r(-10, 20);
      put(b, 0, 'A' + row, criterion); put(b, 0, 'C' + row, v); if (criterion > 0) sum += v;
    }
    put(b, 0, 'F1', '=SUMIF(A1:A' + h + ',">0",C1)');
    watch = [[0, 'F1']]; knownActual = [sum]; expected = [sum + delta]; edit = [0, 'C' + target, b.sheets[0].cells['C' + target].v + delta];
  } else if (family === 'dynamic-spill') {
    const rows = r(2, 6), cols = r(1, 4), start = r(-10, 10), step = r(1, 4);
    const f = 'SEQUENCE(' + [rows, cols, start, step].join(',') + ')';
    edit = [0, 'A1', '=' + f]; watch = []; expected = [];
    for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) { watch.push([0, F.cellName(rr, cc)]); expected.push(start + (rr * cols + cc) * step); }
    knownActual = expected.map((v, i) => i === 0 ? v : null);
    equivalent = { array: [0, 'A1:' + F.cellName(rows - 1, cols - 1)], formula: f,
      limitation: 'Explicit array verifies SEQUENCE values, not automatic spill placement or resizing.' };
  } else if (family === 'iteration') {
    b.calc = { iterate: true, iterateCount: 100, iterateDelta: 0.000001 };
    put(b, 0, 'A1', '=(A1+' + x + ')/2'); b.sheets[0].cells.A1.v = 0;
    watch = [[0, 'A1']]; knownActual = [x / 2]; expected = [x]; tolerance = 0.000002;
  } else throw new Error('Unknown family ' + family);
  const w = model(b);
  if (edit) {
    if (family !== 'dynamic-spill') assert.deepEqual(values(w, watch), knownActual, 'pre-edit control');
    enter(w, ...edit); put(b, ...edit);
  }
  const actual = values(w, watch);
  if (!['dynamic-spill', 'iteration'].includes(family)) assert.deepEqual(values(model(b), watch), expected, 'full calculation must resolve the stale result');
  const status = matches(actual, expected, tolerance) ? 'XPASS' : matches(actual, knownActual) ? 'KNOWN_FAIL' : 'FAIL';
  return { book: b, watch, expected, actual, knownActual, tolerance, edit, equivalent, status };
}

function legacyHarnessCase() {
  const file = path.join(ROOT, 'tests/ledger/calc.test.js');
  const runner = `
    const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
    const file = process.argv[1], original = fs.readFileSync(file, 'utf8');
    if (!original.includes("t('C1', 55)")) throw new Error('Review the mutation: C1 fixture changed');
    const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(original.replace("t('C1', 55)", "t('C1', 56)"), file);
  `;
  const result = spawnSync(process.execPath, ['-e', runner, file], { encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  assert.match(result.stdout, /FAIL C1 => 55 expected 56/, 'the intended assertion must execute');
  assert.equal(result.stderr, '', 'an unrelated runtime error must not count as a successful assertion');
  return { id: 'legacy-harness-exit', family: 'legacy-harness-exit', baseline: BASELINE,
    reason: 'A deliberately wrong expectation prints FAIL but exits successfully; mutation is in memory only.',
    status: result.status === 0 ? 'KNOWN_FAIL' : 'XPASS', expected: 'nonzero exit status', actual: result.status };
}

// Confirmed directly in LibreOffice 25.2.3.2, October 12. One representative
// per cause, not one "bug" per function/seed. Excel 2016 has these functions;
// these are Calc compatibility regressions, NOT an executed Excel acceptance.
// Round 1 exploration: tmp/ledger-fuzz-202610/distinct-ZJG1o5/.
// Round 2 exploration: tmp/ledger-fuzz-202610/boundary-numeric-N2S3Xl/;
// minimized direct checks: tmp/ledger-fuzz-202610/boundary-minimized-ahCe6r/.
// Every retained reproducer is reverified by --libreoffice, independent of tmp.
const NEW_FAILURES = {
  'database-error': { expected: { error: '#N/A' }, actual: 0,
    reason: 'Database aggregates discard an error in a selected record before aggregating.' },
  'database-missing-field': { expected: 2, actual: 0,
    reason: 'DCOUNT with its field omitted returns zero instead of counting matching records.' },
  'database-counta-empty-string': { expected: 1, actual: 0,
    reason: 'DCOUNTA treats a formula returning empty text as an empty cell.' },
  'subtotal-quoted-function': { expected: 9, actual: 0,
    reason: 'The nested-subtotal detector scans quoted text and drops an ordinary numeric cell.' },
  'subtotal-counta-error': { expected: 1, actual: 0,
    reason: 'SUBTOTAL COUNTA removes error-valued cells instead of counting them.' },
  'countif-numeric-text-not-equal': { expected: 1, actual: 2,
    reason: 'COUNTIF numeric inequality accepts numeric text unconditionally; equality coerces it.' },
  'duration-coupon-fraction': { expected: 3.97633104326818, actual: 3.9744258603285143, tolerance: 1e-12,
    reason: 'Actual/actual bond duration disagrees with Calc around a February coupon boundary.' },
  'rept-negative-fraction': { expected: { error: '#VALUE!' }, actual: '',
    reason: 'Text functions truncate a negative fractional length to zero before checking its sign.' },
  'sumifs-error-criterion': { expected: { error: '#N/A' }, actual: 7,
    reason: 'SUMIFS matches an error-valued criterion instead of propagating the criterion error.' },
  // Round 2. Related symptoms are grouped, not counted as separate discoveries.
  'complex-pure-imaginary': { round: 2, expected: 2, actual: 1,
    reason: 'The complex parser reads a pure imaginary coefficient as the real part, then supplies an imaginary coefficient of one.',
    related: ['IMREAL', 'IMABS', 'IMAGINARY and other consumers of parseCx'] },
  'complex-division-scaling': { round: 2, expected: 1, actual: { error: '#NUM!' },
    reason: 'Complex division squares unscaled components; large or tiny finite operands overflow or underflow the denominator.',
    related: ['IMDIV with large and small components'] },
  'factorial-intermediate-overflow': { round: 2, expected: 171, actual: { error: '#NUM!' },
    reason: 'MULTINOMIAL evaluates overflowing factorial intermediates even when the final coefficient is small.',
    related: ['BESSELJ and BESSELI high-order series also divide by the overflowing C.fact result; grouped conservatively'] },
  'base-fractional-padding': { round: 2, expected: '01', actual: '001',
    reason: 'BASE never truncates its positive fractional minimum length, so the padding loop rounds it up.',
    specification: 'https://support.microsoft.com/en-us/excel/functions/base-function' },
  'text-kana-width': { round: 2, expected: 'ｶﾞ', actual: 'ガ',
    reason: 'ASC width conversion handles full-width ASCII but omits katakana and its voiced mark.',
    specification: 'https://support.microsoft.com/en-us/excel/functions/asc-function' },
  'proper-unicode-words': { round: 2, expected: 'Привет Мир', actual: 'привет мир',
    reason: 'PROPER detects word starts with a Latin-only character class, leaving Cyrillic and Greek words lowercase.',
    related: ['Cyrillic and Greek title casing'] },
  'pmt-small-rate-cancellation': { round: 2, expected: -100.00000000064999, actual: -99.991110733227, tolerance: 1e-10,
    reason: 'PMT loses significant digits when subtracting one from the near-one compounding factor.' },
  'cse-reference-coercion': { round: 2, expected: 3, actual: 1,
    reason: 'N scalarizes a reference before honoring legacy array evaluation, so only its first cell contributes.',
    related: ['N with numeric or logical references', 'T with text references'] },
  'trend-grid-shape': { round: 2, expected: 8, actual: { error: '#REF!' },
    reason: 'Single-predictor TREND flattens a two-dimensional new_x array into one row, losing its output shape.',
    related: ['GROWTH uses the same prediction and output-shape path'] },
  'matrix-small-pivot': { round: 2, expected: 1, actual: 0, tolerance: 1e-12,
    reason: 'LU decomposition treats every pivot below 1e-300 as zero, so an invertible scaled matrix gets determinant zero.' },
  'inverse-cdf-small-result': { round: 2, expected: 1e-60, actual: 4.440892098500626e-16, tolerance: 1e-70,
    reason: 'The inverse-CDF solver stops at an absolute interval floor near 1e-15, far above a valid tiny quantile.',
    related: ['GAMMAINV and BETAINV small quantiles', 'CHIINV tail accuracy also suffers from absolute solver tolerances'] },
  'gamma-intermediate-power': { round: 2, expected: 9.483367566824801, actual: { error: '#NUM!' }, tolerance: 1e-11,
    reason: 'The Lanczos gamma calculation overflows its power before multiplying by the small exponential factor; the final value is finite.' },
  'fisherinv-positive-overflow': { round: 2, expected: 1, actual: { error: '#NUM!' },
    reason: 'FISHERINV forms infinity divided by infinity for large positive inputs instead of approaching one.' },
};
function distinctCases() {
  const specs = [
    ['database-error', { A1: 'Key', B1: 'Value', A2: 'x', B2: '=NA()', D1: 'Key', D2: 'x' }, 'DSUM(A1:B2,2,D1:D2)'],
    ['database-missing-field', { A1: 'Key', B1: 'Value', A2: 'x', B2: 3, A3: 'x', B3: 5, D1: 'Key', D2: 'x' }, 'DCOUNT(A1:B3,,D1:D2)'],
    ['database-counta-empty-string', { A1: 'Key', B1: 'Value', A2: 'x', B2: '=""', D1: 'Key', D2: 'x' }, 'DCOUNTA(A1:B2,2,D1:D2)'],
    ['subtotal-quoted-function', { A1: '=LEN("SUBTOTAL(")' }, 'SUBTOTAL(9,A1:A1)'],
    ['subtotal-counta-error', { A1: '=NA()' }, 'SUBTOTAL(3,A1:A1)'],
    ['countif-numeric-text-not-equal', { A1: '0', A2: 1 }, 'COUNTIF(A1:A2,"<>0")'],
    ['duration-coupon-fraction', {}, 'DURATION(DATE(2016,2,28),DATE(2020,8,31),0.05,0.06,2,1)'],
    ['rept-negative-fraction', {}, 'REPT("x",-0.5)'],
    ['sumifs-error-criterion', { A1: '=NA()', B1: 7 }, 'SUMIFS(B1:B1,A1:A1,NA())'],
    ['complex-pure-imaginary', {}, 'IMAGINARY("2i")'],
    ['complex-division-scaling', {}, 'IMREAL(IMDIV("1e200+1e200i","1e200+1e200i"))'],
    ['factorial-intermediate-overflow', {}, 'MULTINOMIAL(170,1)'],
    ['base-fractional-padding', {}, 'BASE(1,2,2.5)'],
    ['text-kana-width', {}, 'ASC("ガ")'],
    ['proper-unicode-words', {}, 'PROPER("привет мир")'],
    ['pmt-small-rate-cancellation', {}, 'PMT(1e-12,12,1200)'],
    ['cse-reference-coercion', { A1: 1, A2: 2 }, 'SUM(N(A1:A2))', true],
    ['trend-grid-shape', {}, 'INDEX(TREND({2;4;6},{1;2;3},{1,2;3,4}),2,2)', true],
    ['matrix-small-pivot', {}, '1e301*MDETERM({1e-301})'],
    ['inverse-cdf-small-result', {}, 'BETAINV(1e-6,0.1,1)'],
    ['gamma-intermediate-power', {}, 'GAMMA(171.5)/1e307'],
    ['fisherinv-positive-overflow', {}, 'FISHERINV(400)'],
  ];
  assert.equal(specs.length, Object.keys(NEW_FAILURES).length, 'every finding has one reproducer');
  assert.equal(new Set(specs.map(s => s[0])).size, specs.length, 'no duplicate finding IDs');
  return specs.map(([id, cells, formula, array = false]) => {
    const b = book(); for (const [a, value] of Object.entries(cells)) put(b, 0, a, value);
    put(b, 0, 'H1', '=' + formula);
    if (array) b.sheets[0].cells.H1.af = { r1: 0, c1: 7, r2: 0, c2: 7 };
    const watch = [[0, 'H1']];
    const rule = NEW_FAILURES[id], actual = values(model(b), watch), expected = [rule.expected], knownActual = [rule.actual];
    const status = matches(actual, expected, rule.tolerance) ? 'XPASS' : matches(actual, knownActual, rule.tolerance) ? 'KNOWN_FAIL' : 'FAIL';
    return { id, family: id, round: rule.round || 1, reason: rule.reason, related: rule.related, specification: rule.specification,
      book: b, formula, array, watch, expected, actual, knownActual, tolerance: rule.tolerance, status, added: '2026-10-12', excelVerification: 'not run' };
  });
}

// Python is embedded so there is only one source file for cases and the oracle.
const UNO_HELPER = String.raw`
import json, os, re, signal, subprocess, sys, time, uuid, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr
import uno
from com.sun.star.beans import PropertyValue

root = Path(sys.argv[1]).resolve()
jobs = json.loads((root / 'oracle-input.json').read_text())
soffice = os.environ.get('LEDGER_FUZZ_SOFFICE', 'soffice')
ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
# Some pre-2016 functions are stored with OOXML's future prefix. The modern
# opt-in cases also need it. Calc 25.2 imports IMTAN/IMSINH/etc. without it;
# BAHTTEXT needs it. Import failures must never be counted as engine findings.
future = set('AGGREGATE CEILING.MATH FLOOR.MATH CEILING.PRECISE FLOOR.PRECISE ISOWEEKNUM NUMBERVALUE IFNA NORM.DIST NORM.S.INV BINOM.DIST POISSON.DIST T.DIST PERCENTILE.EXC RANK.AVG PERCENTRANK.INC COVARIANCE.P BASE DECIMAL BITAND BITOR BITXOR BITLSHIFT BITRSHIFT UNICODE UNICHAR BAHTTEXT GAMMA SEQUENCE LAMBDA'.split())
def formula_xml(f):
    # Split off quoted literals: never rewrite function-like text in a string.
    chunks = re.split(r'("(?:[^"]|"")*")', f)
    for i in range(0, len(chunks), 2):
        chunks[i] = re.sub(r'(?<![A-Za-z0-9_.])([A-Z][A-Z0-9.]*)\(', lambda m: ('_xlfn.' if m[1] in future else '') + m[0], chunks[i])
    return ''.join(chunks)
def prop(k, v):
    p = PropertyValue(); p.Name = k; p.Value = v; return p
def xlsx(job, target):
    b = job['book']; sheets = b['sheets']
    types = ['<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>']
    sheet_defs = []; links = []; parts = {}
    for i, sheet in enumerate(sheets, 1):
        sheet_defs.append('<sheet name=' + quoteattr(sheet['name']) + ' sheetId="%d" r:id="s%d"/>' % (i, i))
        links.append('<Relationship Id="s%d" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>' % (i, rel, i))
        types.append('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % i)
        rows = {}
        for addr, cell in sheet['cells'].items():
            row = int(''.join(c for c in addr if c.isdigit()))
            if 'f' in cell:
                # Calc imports these as OOXML future functions, not custom names.
                f = formula_xml(cell['f'])
                af = cell.get('af')
                array = ' t="array" ref=' + quoteattr(addr) if af else ''
                body = '<f' + array + '>' + escape(f) + '</f><v>0</v>'; typ = ''
            elif cell.get('v') is None:
                body = ''; typ = ''
            elif isinstance(cell.get('v'), bool):
                body = '<v>' + str(int(cell['v'])) + '</v>'; typ = ' t="b"'
            elif isinstance(cell.get('v'), str):
                body = '<is><t xml:space="preserve">' + escape(cell['v']) + '</t></is>'; typ = ' t="inlineStr"'
            else:
                body = '<v>' + str(cell.get('v', 0)) + '</v>'; typ = ''
            col = 0
            for ch in addr:
                if ch.isalpha(): col = col * 26 + ord(ch) - 64
            rows.setdefault(row, []).append((col, '<c r=' + quoteattr(addr) + typ + '>' + body + '</c>'))
        data = ''.join('<row r="%d"%s>%s</row>' % (r, ' hidden="1"' if sheet.get('rows', {}).get(str(r), {}).get('hidden') else '', ''.join(cell for col, cell in sorted(cs))) for r, cs in sorted(rows.items()))
        parts['xl/worksheets/sheet%d.xml' % i] = '<worksheet xmlns="%s"><sheetData>%s</sheetData></worksheet>' % (ns, data)
    names = ''
    for name in b['names']:
        scope = '' if name.get('scope') is None else ' localSheetId="%d"' % name['scope']
        names += '<definedName name=' + quoteattr(name['name']) + scope + '>' + escape(formula_xml(name['ref'])) + '</definedName>'
    cp = b.get('calc', {})
    calc = '<calcPr fullCalcOnLoad="1" forceFullCalc="1" iterate="%d" iterateCount="%d" iterateDelta="%s"/>' % (bool(cp.get('iterate')), cp.get('iterateCount', 100), cp.get('iterateDelta', 0.001))
    parts['xl/workbook.xml'] = '<workbook xmlns="%s" xmlns:r="%s"><workbookPr date1904="%d"/><sheets>%s</sheets>%s%s</workbook>' % (ns, rel, bool(b.get('date1904')), ''.join(sheet_defs), '<definedNames>' + names + '</definedNames>' if names else '', calc)
    parts['xl/_rels/workbook.xml.rels'] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + ''.join(links) + '</Relationships>'
    parts['_rels/.rels'] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="%s/officeDocument" Target="xl/workbook.xml"/></Relationships>' % rel
    parts['[Content_Types].xml'] = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + ''.join(types) + '</Types>'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, xml in parts.items(): z.writestr(name, '<?xml version="1.0" encoding="UTF-8"?>' + xml)
def read(doc, watch):
    out = []; sheets = doc.Sheets; cache = {}
    for s, a in watch:
        if s not in cache: cache[s] = sheets.getByIndex(s)
        c = cache[s].getCellRangeByName(a); err = c.Error
        if err: out.append({'error': c.String, 'code': err})
        else:
            # getDataArray preserves formula text results, unlike c.Value.
            v = c.getDataArray()[0][0]
            out.append(None if v == '' and c.Type.value == 'EMPTY' else v)
    return out
def canonical_errors(target, watch, values):
    # Calc's UI uses Err:502 for some errors; XLSX records the Excel error token.
    with zipfile.ZipFile(target) as z:
        sheets = {}
        for (s, a), value in zip(watch, values):
            if not isinstance(value, dict) or 'error' not in value: continue
            if s not in sheets:
                tree = ET.fromstring(z.read('xl/worksheets/sheet%d.xml' % (s + 1)))
                sheets[s] = {c.get('r'): c.findtext('{%s}v' % ns) for c in tree.iter('{%s}c' % ns) if c.get('t') == 'e'}
            value['xlsxError'] = sheets[s].get(a)
profile = root / 'lo-profile'; profile.mkdir()
inputs = root / 'lo-input'; inputs.mkdir()
outputs = root / 'lo-output'; outputs.mkdir()
pipe = 'ledger_fuzz_' + uuid.uuid4().hex
def terminate(signum, frame):
    raise SystemExit('LibreOffice verification was terminated')
signal.signal(signal.SIGTERM, terminate)
office = subprocess.Popen([soffice, '-env:UserInstallation=' + profile.as_uri(), '--headless', '--nologo', '--nodefault', '--norestore', '--nofirststartwizard', '--accept=pipe,name=' + pipe + ';urp;StarOffice.ComponentContext'], stdout=subprocess.DEVNULL, stderr=sys.stderr)
try:
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    deadline = time.monotonic() + 20
    while True:
        try:
            ctx = resolver.resolve('uno:pipe,name=' + pipe + ';urp;StarOffice.ComponentContext'); break
        except Exception:
            if office.poll() is not None or time.monotonic() > deadline: raise RuntimeError('Calc did not start')
            time.sleep(0.05)
    desktop = ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', ctx)
    print(json.dumps({'version': subprocess.check_output([soffice, '--version'], text=True).strip()}), flush=True)
    for job in jobs:
        target = inputs / (job['id'] + '.xlsx'); xlsx(job, target)
        doc = None
        try:
            doc = desktop.loadComponentFromURL(target.as_uri(), '_blank', 0, (prop('Hidden', True), prop('UpdateDocMode', 0), prop('MacroExecutionMode', 0)))
            if doc is None: raise RuntimeError('Calc did not open ' + str(target))
            cp = job['book'].get('calc', {})
            doc.IsIterationEnabled = bool(cp.get('iterate'))
            doc.IterationCount = cp.get('iterateCount', 100); doc.IterationEpsilon = cp.get('iterateDelta', 0.001)
            doc.calculateAll()
            result = {'id': job['id'], 'direct': read(doc, job['watch'])}
            saved = outputs / (job['id'] + '.xlsx')
            doc.storeToURL(saved.as_uri(), (prop('FilterName', 'Calc MS Excel 2007 XML'), prop('Overwrite', True)))
            canonical_errors(saved, job['watch'], result['direct'])
            eq = job.get('equivalent')
            if eq:
                if 'array' in eq:
                    s, a = eq['array']; doc.Sheets.getByIndex(s).getCellRangeByName(a).setArrayFormula('=' + eq['formula'].replace(',', ';'))
                else:
                    s, a = eq['cell']; doc.Sheets.getByIndex(s).getCellRangeByName(a).setFormula('=' + eq['formula'].replace('!', '.').replace(',', ';'))
                doc.calculateAll(); result['equivalent'] = read(doc, job['watch'])
                result['limitation'] = eq['limitation']
                doc.storeToURL((outputs / (job['id'] + '-equivalent.xlsx')).as_uri(), (prop('FilterName', 'Calc MS Excel 2007 XML'), prop('Overwrite', True)))
            print(json.dumps(result), flush=True)
        finally:
            if doc is not None: doc.close(True)
finally:
    office.terminate()
    try: office.wait(timeout=5)
    except subprocess.TimeoutExpired: office.kill(); office.wait()
`;

async function libreoffice(jobs, directory, progress = () => {}) {
  fs.writeFileSync(path.join(directory, 'oracle-input.json'), JSON.stringify(jobs, null, 2) + '\n');
  const results = [], python = process.env.LEDGER_FUZZ_PYTHON || '/usr/bin/python3';
  await new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', UNO_HELPER, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '', stderr = '', parseError = null;
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
    child.stderr.on('data', d => { stderr += d; });
    child.stdout.on('data', d => {
      pending += d;
      for (;;) {
        const i = pending.indexOf('\n'); if (i < 0) break;
        const line = pending.slice(0, i); pending = pending.slice(i + 1);
        if (line) try { results.push(JSON.parse(line)); timer.refresh(); progress(results.length - 1); }
        catch (error) { parseError = error; child.kill('SIGTERM'); }
      }
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (parseError) reject(parseError);
      else if (code === 0 && !pending.trim()) resolve();
      else reject(new Error('LibreOffice verification failed (' + code + '): ' + stderr));
    });
  });
  fs.writeFileSync(path.join(directory, 'libreoffice.json'), JSON.stringify(results, null, 2) + '\n');
  assert.equal(results.length, jobs.length + 1, 'one LibreOffice result per fixture');
  return results;
}

async function main() {
  const o = options(); fs.mkdirSync(o.out, { recursive: true });
  const directory = fs.mkdtempSync(path.join(o.out, 'run-'));
  const results = [], jobs = [], counts = {}, sourceHashes = {};
  const sources = [...Object.keys(require.cache).filter(file => file.startsWith(path.join(ROOT, 'public') + path.sep)), __filename, path.join(ROOT, 'tests/ledger/calc.test.js')];
  for (const file of sources.sort()) sourceHashes[path.relative(ROOT, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const record = result => { results.push(result); counts[result.status] = (counts[result.status] || 0) + 1; };
  const scalar = book(); scalar.sheets.pop(); const scalarWatch = [], scalarExpected = [];
  const w = model(book());
  for (let i = 0; i < o.count * 32; i++) {
    const seed = (o.seed + i) >>> 0, e = expression(random(seed), 3), id = 'arithmetic-' + seed;
    if (e.v === 0) e.v = 0; // A spreadsheet has one zero; JS multiplication can produce -0.
    try {
      assert.equal(C.evalScalar(w, w.sheets[0], 0, 0, e.f), e.v);
      assert.equal(C.evalScalar(w, w.sheets[0], 0, 0, F.toText(F.parse(e.f))), e.v);
      record({ id, seed, status: 'PASS' });
    } catch (error) { record({ id, seed, status: 'FAIL', formula: e.f, expected: e.v, error: error.message }); }
    put(scalar, 0, 'A' + (i + 1), '=' + e.f); scalarWatch.push([0, 'A' + (i + 1)]); scalarExpected.push(e.v);
  }
  jobs.push({ id: 'arithmetic', book: scalar, watch: scalarWatch, expected: scalarExpected });
  // Guard the oracle itself: distinguish numbers, text, empty text, true blank,
  // logicals and errors before claiming any cross-application agreement.
  const calibration = book(), calibrationWatch = [];
  ['=1+2', '="text"', '=""', '=TRUE()', null, '=NA()', '="0"', '=FALSE()'].forEach((v, i) => {
    const a = 'A' + (i + 1); if (v !== null) put(calibration, 0, a, v); calibrationWatch.push([0, a]);
  });
  const calibrationExpected = [3, 'text', '', true, null, { error: '#N/A' }, '0', false];
  assert.deepEqual(values(model(calibration), calibrationWatch), calibrationExpected);
  assert(!closeValue(4.440892098500626e-16, 1e-60, 1e-9, 0), 'relative-only comparison must reject a wrong tiny quantile');
  assert(closeValue(1.000000000001e-60, 1e-60, 1e-9, 0), 'relative-only comparison must allow ordinary rounding');
  jobs.push({ id: 'oracle-calibration', book: calibration, watch: calibrationWatch, expected: calibrationExpected });
  record({ id: 'oracle-calibration', status: 'PASS' });
  for (let i = 0; i < o.count; i++) {
    const seed = (o.seed + i) >>> 0, id = 'graph-' + seed;
    try { const c = graphCase(seed); jobs.push({ id, ...c }); record({ id, seed, status: 'PASS', editCount: c.trace.length }); }
    catch (error) { record({ id, seed, status: 'FAIL', error: error.stack }); }
    if (o.libreoffice) jobs.push(legacyBatch(seed), boundaryBatch(seed));
  }
  // Old failures remain covered once each. More seeds must not inflate bugs.
  for (const [family, reason] of Object.entries(FAMILIES)) {
    if (!o.modern && ['named-lambda', 'dynamic-spill'].includes(family)) continue;
    const seed = 20261011, id = family + '-' + seed;
    try {
      const c = knownCase(family, seed);
      record({ id, seed, family, status: c.status, reason, baseline: BASELINE, expected: c.expected, actual: c.actual, edit: c.edit, watch: c.watch });
      jobs.push({ id, family, ...c });
    } catch (error) { record({ id, seed, family, status: 'FAIL', error: error.stack }); }
  }
  for (const c of distinctCases()) {
    jobs.push(c); const { book, ...finding } = c; record(finding);
  }
  try { record(legacyHarnessCase()); }
  catch (error) { record({ id: 'legacy-harness-exit', status: 'FAIL', error: error.stack }); }
  const report = { baseline: BASELINE, head, node: process.version, seed: o.seed, count: o.count,
    scope: o.modern ? 'through Excel 2016 plus two deferred modern regressions' : 'through Excel 2016',
    excelVerification: 'not run', differentialVerification: o.libreoffice ? 'pending' : 'not run: use --libreoffice',
    sourceHashes, counts, results };
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...counts, seed: o.seed, count: o.count, directory }));
  if (o.libreoffice) {
    console.log('Verifying ' + jobs.length + ' workbook states in isolated LibreOffice…');
    const lo = await libreoffice(jobs, directory, done => { if (done && done % 16 === 0) console.log('LibreOffice: ' + done + '/' + jobs.length + ' workbooks'); });
    const byId = new Map(lo.slice(1).map(x => [x.id, x]));
    const summary = { version: lo[0].version, direct: 0, equivalentOnly: 0, failed: 0, comparisons: [] };
    for (const job of jobs) {
      const result = byId.get(job.id), tolerance = job.tolerance || 1e-10;
      if (job.differential) {
        const comparisons = job.cases.map((c, i) => {
          const actual = job.actual.slice(i * 2, i * 2 + 2), raw = result.direct.slice(i * 2, i * 2 + 2), expected = raw.map(oracleValue);
          const unsupported = raw.some(v => v && v.code === 539);
          const ok = !unsupported && actual.every((v, k) => closeValue(v, expected[k], 1e-9, c.absoluteTolerance ?? 1e-9));
          const comparison = { id: job.id + '-' + c.area + '-' + c.name, seed: job.seed, ...c, actual, expected, status: ok ? 'PASS' : 'FAIL', ...(unsupported ? { oracleError: 'Calc rejected an inline array; this is not a behavioral oracle.' } : {}) };
          record(comparison); return comparison;
        });
        const direct = comparisons.every(c => c.status === 'PASS');
        summary[direct ? 'direct' : 'failed']++;
        summary.comparisons.push({ id: job.id, status: direct ? 'DIRECT_MATCH' : 'FAIL', formulaCount: comparisons.length });
        continue;
      }
      const direct = matches(result.direct.map(oracleValue), job.expected.map(oracleValue), tolerance);
      const equivalent = result.equivalent && matches(result.equivalent, job.expected, tolerance);
      const status = direct ? 'DIRECT_MATCH' : equivalent ? 'EQUIVALENT_ONLY' : 'FAIL';
      summary[direct ? 'direct' : equivalent ? 'equivalentOnly' : 'failed']++;
      summary.comparisons.push({ id: job.id, status, ...(direct ? {} : { expected: job.expected, actual: result.direct, equivalent: result.equivalent, limitation: result.limitation }) });
    }
    report.libreoffice = summary;
    report.differentialVerification = 'direct calculation in ' + summary.version;
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...summary, comparisons: undefined }));
  }
  report.uniqueNewFindings = results.filter(x => x.added && x.status === 'KNOWN_FAIL').length;
  report.findingsByRound = {};
  for (const x of results.filter(x => x.added && x.status === 'KNOWN_FAIL')) report.findingsByRound[x.round] = (report.findingsByRound[x.round] || 0) + 1;
  report.uniqueKnownFindings = new Set(results.filter(x => x.status === 'KNOWN_FAIL').map(x => x.family)).size;
  report.sourcesUnchanged = sources.every(file => sourceHashes[path.relative(ROOT, file)] === crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  if (!report.sourcesUnchanged) throw new Error('Source changed during this run; repeat before using its results');
  if (counts.FAIL || counts.XPASS || report.libreoffice?.failed || o.strict && counts.KNOWN_FAIL) process.exitCode = 1;
  for (const result of results.filter(x => x.status === 'FAIL' || x.status === 'XPASS')) console.error(JSON.stringify(result));
  console.log('Report: ' + path.join(directory, 'results.json'));
  console.log(JSON.stringify({ ...counts, uniqueNewFindings: report.uniqueNewFindings, findingsByRound: report.findingsByRound, uniqueKnownFindings: report.uniqueKnownFindings }));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { legacyBatch, boundaryBatch, distinctCases, libreoffice, closeValue, model, values, book, put, ROOT };
