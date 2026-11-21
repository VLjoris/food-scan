#!/usr/bin/env node
/*
 * Collects candidate Belgian store-attributed EANs from Open Prices
 * (https://prices.openfoodfacts.org/api/v1). Output: candidates JSON on stdout.
 *
 * How test/fixtures/be-products.json was built:
 *  1. `node tools/source-barcodes.js > candidates.json` lists, per store, EANs
 *     with prices recorded at BE locations (/locations?osm_name__like=<brand>,
 *     filtered client-side on osm_address_country_code=BE, then
 *     /prices?location_id=<id>&product_code__isnull=false).
 *  2. Candidates were hand-curated into groups: A-brands seen at >=2 stores,
 *     size/multipack variants, private-label lines (Boni/Everyday, 365/Delhaize,
 *     Lidl house brands, AH) and edge cases (EAN-8, UPC-A/E, GTIN-14, 2x
 *     variable-weight, bad checksum).
 *  3. Manual additions (retailer-page / OFF-store evidence, synthetic edge
 *     cases) carry their own source.url / source.type in the JSON.
 *  4. Checksums are validated by `node tools/source-barcodes.js --verify`.
 *
 * Polite: <=1 request/s, retries on 429/503, descriptive User-Agent.
 */
'use strict';

const UA = 'food-scan-poc/0.1 (github.com/VLjoris/food-scan)';
const BASE = 'https://prices.openfoodfacts.org/api/v1';
const STORES = { colruyt: 'Colruyt', delhaize: 'Delhaize', lidl: 'Lidl', 'albert-heijn': 'Albert Heijn' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let last = 0;

async function get(path, params) {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = Math.max(0, last + 1000 - Date.now());
    if (wait) await sleep(wait);
    last = Date.now();
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 429 || res.status === 503) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
  throw new Error(`gave up ${url}`);
}

function upcEToA(e) {
  const [ns, d1, d2, d3, d4, d5, d6, chk] = e.split('');
  if (d6 <= '2') return `${ns}${d1}${d2}${d6}0000${d3}${d4}${d5}${chk}`;
  if (d6 === '3') return `${ns}${d1}${d2}${d3}00000${d4}${d5}${chk}`;
  if (d6 === '4') return `${ns}${d1}${d2}${d3}${d4}00000${d5}${chk}`;
  return `${ns}${d1}${d2}${d3}${d4}${d5}0000${d6}${chk}`;
}

function gs1Valid(code, symbology) {
  if (symbology === 'UPC_E') return /^[01]\d{7}$/.test(code) && gs1Valid(upcEToA(code));
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  d.reverse().forEach((x, i) => { sum += x * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

async function candidates() {
  const out = {};
  for (const [store, name] of Object.entries(STORES)) {
    const locs = [];
    for (let page = 1; page <= 5; page++) {
      const j = await get('/locations', { osm_name__like: name, size: 100, page, order_by: '-price_count' });
      locs.push(...j.items.filter(l => l.osm_address_country_code === 'BE'));
      if (page >= j.pages) break;
    }
    const eans = new Set();
    for (const l of locs.slice(0, 15)) {
      const j = await get('/prices', { location_id: l.id, product_code__isnull: false, size: 100 });
      j.items.forEach(p => p.product_code && eans.add(p.product_code));
    }
    out[store] = [...eans];
  }
  return out;
}

// Fallback: OFF search by stores_tags + brands_tags (source.type "off-stores").
// Usage: node tools/source-barcodes.js --off <store-tag> <brand-tag> [pages]
async function offSearch(store, brand, pages = 2) {
  const rows = [];
  for (let page = 1; page <= pages; page++) {
    const q = new URLSearchParams({ stores_tags: store, brands_tags: brand, fields: 'code,product_name,brands,quantity', page_size: 50, page });
    const url = `https://world.openfoodfacts.org/api/v2/search?${q}`;
    let j = null;
    for (let attempt = 0; attempt < 6 && !j; attempt++) {
      await sleep(Math.max(1000, 2000 * attempt));
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) j = await res.json();
    }
    if (!j) break;
    rows.push(...j.products.map(p => ({ ...p, url })));
  }
  return rows;
}

if (require.main === module) {
  if (process.argv[2] === '--off') {
    offSearch(process.argv[3], process.argv[4], Number(process.argv[5]) || 2)
      .then(r => console.log(JSON.stringify(r, null, 1)));
    return;
  }
  if (process.argv.includes('--verify')) {
    const rows = require('../test/fixtures/be-products.json');
    const bad = rows.filter(r => gs1Valid(r.ean, r.symbology) !== r.expectValid);
    console.log(bad.length ? bad : `ok ${rows.length} rows`);
    process.exit(bad.length ? 1 : 0);
  }
  candidates().then(c => console.log(JSON.stringify(c, null, 1)), e => { console.error(e); process.exit(1); });
}

module.exports = { gs1Valid };
