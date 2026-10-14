/* The functions rewritten for todos/CLEAN_APACHE2.0.md (phase 1) keep their results: VDB, DDB, the gamma and beta
   distributions and everything built on them, BESSELY; then erf, the normal and lognormal distributions and the
   gamma function. The baseline was written by the code before each rewrite, except GAMMA(170.5) and GAMMA(171.6),
   which overflowed to #NUM! there though both are finite (Γ(171.6) ≈ 1.586e308), and the t and F right tails, GAUSS
   and the inverses, written again when they were made exact to mpmath (stat-tails.test.js):
     node tests/ledger/clean-functions.test.js --write    (only on that code)
     node tests/ledger/clean-functions.test.js            (checks; also run by node --test) */
const fs = require('fs');
const path = require('path');
require('../../public/common/core.js');
require('../../public/common/numfmt.js');
for (const f of ['formula', 'model', 'calc', 'fn-core', 'fn-lookup', 'fn-stat', 'fn-fin', 'fn-eng']) require('../../public/ledger/js/' + f + '.js');
const L = globalThis.L, M = L.model, C = L.calc;
const wb = new M.Workbook();
const sh = wb.addSheet('Sheet1');
/* data for the tests of two samples */
[3, 4, 5, 8, 9, 1, 2, 4, 5, 7.5].forEach((v, i) => { sh.cell(i, 0).v = v; });
[6, 19, 3, 2, 14, 4, 5, 17, 1, 2.5].forEach((v, i) => { sh.cell(i, 1).v = v; });
[58, 35, 11, 25, 10, 23].forEach((v, i) => { sh.cell(i, 2).v = v; });
[45.35, 47.65, 13.65, 32.4, 16.6, 4.75].forEach((v, i) => { sh.cell(i, 3).v = v; });
C.recalcAll(wb);

const F = [];
const add = (f) => F.push(f);
/* VDB: whole and partial periods, both ends, factors, no switch, fractional lives, salvage reached early */
for (const [c, s, l] of [[2400, 300, 10], [2400, 300, 120], [10000, 1000, 5], [5000, 0, 7.5], [1000, 900, 4], [7000, 500, 1], [100, 10, 3.3]])
  for (const [a, b] of [[0, 1], [0, 0.5], [0.25, 0.75], [0.5, 1.5], [1, 3], [1.25, 2.75], [2, 2.5], [0, l], [l / 2, l], [l - 0.4, l], [0.9, l - 0.1]])
    for (const f of [2, 1.5, 1, 3, 0.5])
      for (const ns of ['FALSE', 'TRUE']) if (a <= b && b <= l) add(`VDB(${c},${s},${l},${a},${b},${f},${ns})`);
add('VDB(2400,300,10,0,1)'); add('VDB(2400,300,10,6,10,2,FALSE)'); add('VDB(2400,300,10,-1,1)'); add('VDB(2400,300,10,2,1)'); add('VDB(2400,3000,10,0,1)');
for (const [c, s, l] of [[2400, 300, 10], [10000, 1000, 5], [5000, 0, 7.5], [1000, 900, 4]]) for (let p = 1; p <= Math.ceil(l); p++) for (const f of [2, 1.5, 3]) add(`DDB(${c},${s},${l},${p},${f})`);
/* gamma family */
const xs = [0, 1e-6, 0.01, 0.1, 0.5, 1, 2, 3.7, 5, 10, 20, 50, 120, 400];
for (const df of [1, 2, 3, 5, 10, 30, 100, 1000]) for (const x of xs) { add(`CHIDIST(${x},${df})`); add(`CHISQ.DIST(${x},${df},TRUE)`); add(`CHISQ.DIST(${x},${df},FALSE)`); add(`CHISQ.DIST.RT(${x},${df})`); }
for (const df of [1, 2, 5, 10, 30, 100]) for (const p of [1e-8, 0.001, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999]) { add(`CHIINV(${p},${df})`); add(`CHISQ.INV(${p},${df})`); add(`CHISQ.INV.RT(${p},${df})`); }
for (const [a, b] of [[0.5, 1], [1, 1], [2, 3], [9, 0.5], [30, 2], [0.1, 10]]) for (const x of [0.001, 0.5, 1, 4, 10, 50, 200]) { add(`GAMMADIST(${x},${a},${b},TRUE)`); add(`GAMMA.DIST(${x},${a},${b},FALSE)`); }
for (const [a, b] of [[0.5, 1], [2, 3], [9, 0.5], [30, 2]]) for (const p of [0.001, 0.1, 0.5, 0.9, 0.999]) { add(`GAMMAINV(${p},${a},${b})`); add(`GAMMA.INV(${p},${a},${b})`); }
for (const m of [0.1, 1, 2.5, 10, 40, 200]) for (const x of [0, 1, 2, 5, 10, 30, 100, 250]) { add(`POISSON(${x},${m},TRUE)`); add(`POISSON.DIST(${x},${m},FALSE)`); }
/* beta family */
for (const [a, b] of [[0.5, 0.5], [1, 1], [2, 5], [8, 10], [0.2, 3], [50, 40], [300, 2]]) for (const x of [0.001, 0.1, 0.3, 0.5, 0.7, 0.9, 0.999]) { add(`BETADIST(${x},${a},${b})`); add(`BETA.DIST(${x},${a},${b},TRUE)`); add(`BETA.DIST(${x},${a},${b},FALSE)`); }
add('BETADIST(2,8,10,1,3)'); add('BETA.DIST(2,8,10,TRUE,1,3)');
for (const [a, b] of [[0.5, 0.5], [2, 5], [8, 10], [50, 40]]) for (const p of [0.001, 0.1, 0.5, 0.9, 0.999]) { add(`BETAINV(${p},${a},${b})`); add(`BETA.INV(${p},${a},${b},2,4)`); }
/* t, F */
for (const df of [1, 2, 3, 5, 10, 30, 100, 1000]) for (const t of [0, 0.1, 0.5, 1, 1.96, 2.5, 4, 10, 50]) { add(`TDIST(${t},${df},1)`); add(`TDIST(${t},${df},2)`); add(`T.DIST(${-t},${df},TRUE)`); add(`T.DIST(${t},${df},FALSE)`); add(`T.DIST.RT(${t},${df})`); add(`T.DIST.2T(${t},${df})`); }
for (const df of [1, 2, 5, 10, 30, 100]) for (const p of [0.001, 0.01, 0.05, 0.2, 0.5, 0.9]) { add(`TINV(${p},${df})`); add(`T.INV(${p},${df})`); add(`T.INV.2T(${p},${df})`); add(`CONFIDENCE.T(${p},2.5,${df + 1})`); }
for (const [d1, d2] of [[1, 1], [2, 5], [6, 4], [10, 20], [30, 30], [100, 3]]) for (const x of [0, 0.1, 0.5, 1, 2, 4.5, 15.2069, 100]) { add(`FDIST(${x},${d1},${d2})`); add(`F.DIST(${x},${d1},${d2},TRUE)`); add(`F.DIST(${x},${d1},${d2},FALSE)`); add(`F.DIST.RT(${x},${d1},${d2})`); }
for (const [d1, d2] of [[1, 1], [2, 5], [6, 4], [10, 20], [100, 3]]) for (const p of [0.001, 0.01, 0.05, 0.5, 0.95]) { add(`FINV(${p},${d1},${d2})`); add(`F.INV(${p},${d1},${d2})`); add(`F.INV.RT(${p},${d1},${d2})`); }
for (const tails of [1, 2]) for (const type of [1, 2, 3]) { add(`TTEST(A1:A10,B1:B10,${tails},${type})`); add(`T.TEST(A1:A10,B1:B10,${tails},${type})`); }
add('FTEST(A1:A10,B1:B10)'); add('F.TEST(A1:A10,B1:B10)'); add('CHITEST(C1:C6,D1:D6)'); add('CHISQ.TEST(C1:C3,D1:D3)');
/* erf, the normal and lognormal distributions, the gamma function (rewritten from the DLMF in the second round) */
for (const x of [-30, -6, -3.5, -2, -1, -0.5, -0.1, -1e-9, 0, 1e-12, 1e-9, 0.01, 0.1, 0.3, 0.46875, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 4.5, 6, 10, 26, 27, 30]) {
  add(`ERF(${x})`); add(`ERFC(${x})`); add(`ERF.PRECISE(${x})`); add(`ERFC.PRECISE(${x})`); add(`NORMSDIST(${x})`); add(`NORM.S.DIST(${x},TRUE)`); add(`NORM.S.DIST(${x},FALSE)`);
  add(`GAUSS(${x})`); add(`PHI(${x})`); add(`NORMDIST(${x},1.5,2.5,TRUE)`); add(`NORM.DIST(${x},-1,0.5,FALSE)`);
}
add('ERF(0.5,1.5)'); add('ERF(2,-1)');
for (const p of [1e-300, 1e-100, 1e-20, 1e-10, 1e-6, 0.001, 0.02425, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 0.97575, 0.999, 1 - 1e-6, 1 - 1e-10]) {
  add(`NORMSINV(${p})`); add(`NORM.S.INV(${p})`); add(`NORMINV(${p},10,3)`); add(`NORM.INV(${p},-2,0.5)`); add(`LOGINV(${p},0.5,1.2)`); add(`LOGNORM.INV(${p},0,1)`);
  add(`CONFIDENCE(${p},2.5,50)`); add(`CONFIDENCE.NORM(${p},1,10)`);
}
for (const x of [1e-6, 0.1, 0.5, 1, 2, 5, 30, 200]) { add(`LOGNORMDIST(${x},0.5,1.2)`); add(`LOGNORM.DIST(${x},0,1,TRUE)`); add(`LOGNORM.DIST(${x},0,1,FALSE)`); }
for (const z of [-170.5, -10.5, -2.5, -0.5, 1e-300, 1e-10, 0.001, 0.1, 0.5, 1, 1.5, 2, 2.5, 3, 4.5, 7, 9.99, 10, 10.5, 20, 33.3, 50, 100.5, 150, 170.5, 171, 171.6, 172, 1000, 1e6, 1e100]) {
  add(`GAMMA(${z})`); add(`GAMMALN(${z})`); add(`GAMMALN.PRECISE(${z})`);
}
for (const n of [0, 1, 5, 20, 100, 1000]) for (const k of [0, 1, 3, 10, 500]) if (k <= n) { add(`BINOMDIST(${k},${n},0.3,FALSE)`); add(`BINOM.DIST(${k},${n},0.3,TRUE)`); add(`COMBIN(${n},${k})`); }
for (const [x, a, b] of [[2, 3, 4], [0.5, 0.5, 2], [10, 9, 0.5]]) { add(`GAMMA.DIST(${x},${a},${b},FALSE)`); add(`BETA.DIST(${x / 20},${a},${b},FALSE)`); }
/* BESSELY */
for (const n of [0, 1, 2, 3, 5, 10]) for (const x of [0.01, 0.1, 0.5, 1, 2.5, 5, 10, 25, 40, 100]) add(`BESSELY(${x},${n})`);
add('BESSELY(0,1)'); add('BESSELY(-1,1)'); add('BESSELY(1,-1)');

const value = (f) => {
  let v;
  try { v = C.evalScalar(wb, sh, 19, 19, f); } catch (e) { v = 'THROW ' + e.message; }
  return M.isErr(v) ? v.e : v;
};
const file = path.join(__dirname, 'clean-functions.baseline.json');
if (process.argv.includes('--write')) {
  const out = {};
  for (const f of F) out[f] = value(f);
  fs.writeFileSync(file, JSON.stringify(out, null, 0).replace(/,"/g, ',\n"') + '\n');
  console.log(`wrote ${F.length} results to ${path.relative(process.cwd(), file)}`);
} else {
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  /* the same value, or within 1e-11 relative (inverses, found by iteration: 1e-9); below 1e-300 both count as 0; amounts
     of money (VDB, DDB) also within 1e-9 absolute (the old VDB left 1.8e-13 of rounding where the answer is 0) */
  let fail = 0, worst = 0, worstF = '';
  for (const f of F) {
    const exp = base[f], got = value(f);
    if (exp === undefined) { fail++; console.log('NO BASELINE', f); continue; }
    if (typeof exp === 'number' && typeof got === 'number') {
      const tol = /INV/.test(f) ? 1e-9 : 1e-11;
      const err = Math.abs(got - exp) / Math.max(Math.abs(exp), 1e-300);
      if (Math.abs(got) < 1e-300 && Math.abs(exp) < 1e-300) continue;
      if (/^(VDB|DDB)\(/.test(f) && Math.abs(got - exp) <= 1e-9) continue;
      if (err > worst) { worst = err; worstF = f; }
      if (err > tol) { fail++; console.log('CHANGED', f, '=>', got, 'was', exp); }
    } else if (String(exp) !== String(got)) { fail++; console.log('CHANGED', f, '=>', got, 'was', exp); }
  }
  console.log(`${F.length - fail}/${F.length} as before (largest relative change ${worst.toExponential(2)}${worstF ? ' in ' + worstF : ''})`);
  if (fail) process.exitCode = 1;
}
