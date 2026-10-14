// Far tails of the t, F and chi-square distributions and GAUSS near 0 keep their digits: right tails are computed
// directly, not as 1 − cdf, and inverses stop on a relative tolerance. References from mpmath at 40 digits:
//   node --test tests/ledger/stat-tails.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
require('../../public/common/core.js');
require('../../public/common/numfmt.js');
for (const f of ['formula', 'model', 'calc', 'fn-core', 'fn-lookup', 'fn-stat', 'fn-fin', 'fn-eng']) require('../../public/ledger/js/' + f + '.js');
const { model: M, calc: C } = globalThis.L;
const wb = new M.Workbook();
const sh = wb.addSheet('Sheet1');
const near = (f, want, tol) => {
  const got = C.evalScalar(wb, sh, 0, 0, f);
  assert.ok(typeof got === 'number' && Math.abs(got - want) <= tol * Math.abs(want), `${f} = ${got}, want ${want}`);
};

test('right tails of t and F far below 1e-16', () => {
  for (const [f, v] of [['TDIST(10,100,1)', 4.9508444922970696e-17], ['T.DIST.2T(10,1000)', 1.6670702958600066e-22],
    ['T.DIST.RT(50,30)', 9.3577088296113563e-31], ['T.DIST.RT(-3,5)', 9.8495037605126871e-1],
    ['FDIST(100,30,30)', 5.8630495509208051e-23], ['F.DIST.RT(100,10,20)', 7.8251817108074319e-15]]) near(f, v, 1e-12);
});

test('GAUSS near 0', () => {
  near('GAUSS(1e-12)', 3.9894228040143268e-13, 1e-14);
  near('GAUSS(-1e-9)', -3.9894228040143268e-10, 1e-14);
});

test('chi-square and F inverses at tiny probabilities', () => {
  for (const [f, v] of [['CHISQ.INV(1e-8,1)', 1.5707963267948967e-16], ['CHISQ.INV(1e-8,2)', 2.0000000100000001e-8],
    ['CHIINV(1e-8,100)', 200.63190873681667], ['FINV(1e-12,10,20)', 60.509725884917654]]) near(f, v, 1e-12);
});
