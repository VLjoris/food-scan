# 🇧🇪 Belgian Food Scanner (PWA)

Single-user iPhone web app: scan a barcode → look up the product name in
[Open Food Facts](https://world.openfoodfacts.org) → if unknown, type the name once and it is stored
on the phone (IndexedDB) so the next scan resolves locally.

## How it works
1. Camera (`getUserMedia`) + ZXing (vendored in `vendor/`) decode EAN-13/EAN-8/UPC-A/UPC-E. iOS Safari has no `BarcodeDetector`, hence ZXing.
2. Checksum validated (`lib.js`); UPC-A normalised to EAN-13. Belgian GS1 prefix (540–549) is only flagged, never required (store brands are often made abroad).
3. Lookup order: local DB (your entries win) → Open Food Facts v2 (`/api/v2/product/{ean}.json`) → prompt for name. OFF hits are cached locally. A network failure is not treated as "unknown", so you aren't asked to type a name while offline.
4. History tab: filter, delete, export CSV (all product names), JSON backup/restore.

## Install on iPhone
Camera access requires HTTPS, so host it (GitHub Pages is free):

```sh
git add -A && git commit -m "Belgian food scanner PWA" && git push -u origin HEAD:main
```
Then on GitHub: repo **Settings → Pages → Deploy from branch → main / (root)**.
Open `https://vljoris.github.io/food-scan/` in **Safari** on the iPhone →
Share → **Add to Home Screen**. Launch it from the icon, tap **Start camera**, allow camera.

> Pages sites on the free plan are public; the repo holds no personal data — your products live only on the phone.

## Local testing on desktop
`python3 -m http.server 8000` → http://localhost:8000 (localhost counts as secure for the camera).

## Local POC testing
Findings and data sources: [docs/off-findings.md](docs/off-findings.md).

| Command | What it does |
|---|---|
| `node test.js` | Unit tests for `lib.js` |
| `node tools/decode-test.js [-v]` | Renders fixture barcodes (clean + degraded) and decodes them with the vendored ZXing |
| `node tools/off-probe.js [--refresh]` | Checks fixtures against Open Food Facts; `--refresh` re-fetches `test/fixtures/off-snapshot.json` |
| `uv run --with playwright python tools/e2e_camera.py [--live] [--limit N]` | End-to-end: headless Chromium, fake camera fed with rendered barcodes → asserts barcode → name (~15 s) |
| `python3 -m http.server 8000` → `/tools/barcode-sheet.html` | Printable/on-screen barcode sheet to scan with a real phone |

- e2e prerequisites: `uv`, `node`, and once `uv run --with playwright playwright install chromium`. OFF is served from the snapshot unless `--live`.
- Append `?debug=1` to the app URL for a debug panel (raw text, format, EAN, state, name, OFF response); it persists, `?debug=0` turns it off.
- UPC-E is **not decodable** by the vendored ZXing (reported as skipped/known-failing in the tools).

## Notes
- Data lives in the installed app's storage. Use **Backup JSON** now and then; iOS can purge website data after long inactivity or if Safari data is cleared.
- After changing files, bump `CACHE` in `sw.js` so the phone picks up the update.
- One OFF request per new product (results are cached).
