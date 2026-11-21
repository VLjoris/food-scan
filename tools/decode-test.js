#!/usr/bin/env node
/*
 * Decode harness: renders fixture barcodes (clean + degraded) with tools/barcode-render.js, decodes them
 * with the vendored ZXing configured like app.js, normalizes via Lib.normalizeEan and compares with the
 * expected canonical EAN-13. UPC_E is reported separately as known-failing (vendored ZXing cannot read it).
 * Exit 1 if a clean, valid EAN_13/EAN_8/UPC_A row fails. Deterministic (fixed seeds).
 * Usage: node tools/decode-test.js [-v]
 */
'use strict';
const path = require('path');
const Lib = require(path.join(__dirname, '..', 'lib.js'));
const R = require('./barcode-render.js');
const ZXing = require(path.join(__dirname, '..', 'vendor', 'zxing-library.min.js'));
const rows = require(path.join(__dirname, '..', 'test', 'fixtures', 'be-products.json'));

const ENCODABLE = ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E'];
const VARIANTS = {
  clean: {},
  small: { moduleWidth: 1 },
  blur: { blur: 1, seed: 11 },
  noise: { noise: 50, seed: 12 },
  lowContrast: { contrast: 0.35 },
  'rot+5': { rotateDeg: 5 },
  'rot-5': { rotateDeg: -5 },
};
const KNOWN_FAILING = new Set(['UPC_E']);

const hints = new Map([
  [ZXing.DecodeHintType.POSSIBLE_FORMATS, Lib.SCAN_FORMATS.map(n => ZXing.BarcodeFormat[n])],
  [ZXing.DecodeHintType.TRY_HARDER, true],
]);

function decode(g) {
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.RGBLuminanceSource(g.data, g.width, g.height)));
  try {
    const r = reader.decode(bmp);
    return { text: r.getText(), format: ZXing.BarcodeFormat[r.getBarcodeFormat()] };
  } catch (e) { return null; }
}

const equivFormat = (a, b) => a === b || (a === 'UPC_A' && b === 'EAN_13') || (a === 'EAN_13' && b === 'UPC_A');

function run(row, variant) {
  const g = R.toGray(row.ean, row.symbology, Object.assign({ moduleWidth: 3 }, VARIANTS[variant]));
  const res = decode(g);
  if (!res) return row.expectValid ? { ok: false, cause: 'no decode' } : { ok: true };
  const norm = Lib.normalizeEan(res.text, res.format);
  if (!row.expectValid) return norm ? { ok: false, cause: 'invalid code accepted: ' + norm } : { ok: true };
  const expected = Lib.normalizeEan(row.ean, row.symbology === 'UPC_E' ? 'UPC_E' : undefined);
  const digits = res.text.replace(/\D/g, '');
  if (!equivFormat(res.format, row.symbology)) return { ok: false, cause: `wrong format (${res.format}, text ${res.text})` };
  if (!norm) return { ok: false, cause: `normalization mismatch (rejected "${res.text}")` };
  if (norm !== expected) return { ok: false, cause: `wrong digits (${digits}, normalized ${norm}, expected ${expected})` };
  return { ok: true };
}

const stats = {}; // sym -> variant -> {pass,total}
const failures = [];
const skipped = [];
let cleanFail = 0;

for (const row of rows) {
  if (!ENCODABLE.includes(row.symbology)) { skipped.push(row); continue; }
  const sym = row.symbology;
  for (const v of Object.keys(VARIANTS)) {
    let r;
    try { r = run(row, v); } catch (e) { r = { ok: false, cause: 'render error: ' + e.message }; }
    const s = ((stats[sym] = stats[sym] || {})[v] = stats[sym][v] || { pass: 0, total: 0 });
    s.total++;
    if (r.ok) s.pass++;
    else {
      failures.push({ sym, v, ean: row.ean, valid: row.expectValid, cause: r.cause });
      if (v === 'clean' && row.expectValid && !KNOWN_FAILING.has(sym)) cleanFail++;
    }
  }
}

const names = Object.keys(VARIANTS);
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('symbology', 10) + names.map(n => pad(n, 12)).join(''));
for (const sym of ENCODABLE) {
  if (!stats[sym]) continue;
  console.log(pad(sym + (KNOWN_FAILING.has(sym) ? '*' : ''), 10) +
    names.map(n => pad(`${stats[sym][n].pass}/${stats[sym][n].total}`, 12)).join(''));
}
console.log('* known-failing (vendored ZXing cannot decode UPC-E); excluded from exit code');
console.log(`skipped (unencodable): ${skipped.length}${skipped.length ? ' [' + skipped.map(r => r.symbology + ' ' + r.ean).join(', ') + ']' : ''}`);

const real = failures.filter(f => !KNOWN_FAILING.has(f.sym));
const known = failures.filter(f => KNOWN_FAILING.has(f.sym));
console.log(`\nfailures: ${real.length}`);
for (const f of real) console.log(`  ${f.sym} ${f.v} ${f.ean}${f.valid ? '' : ' (invalid)'}: ${f.cause}`);
console.log(`known-failing UPC_E failures: ${known.length}`);
if (process.argv.includes('-v')) for (const f of known) console.log(`  ${f.sym} ${f.v} ${f.ean}: ${f.cause}`);

if (cleanFail) { console.log(`\nFAIL: ${cleanFail} clean valid row(s) failed`); process.exit(1); }
console.log('\nOK');
