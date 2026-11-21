#!/usr/bin/env python3
"""End-to-end camera test: rendered barcode -> fake camera -> app -> product name.

  uv run --with playwright python tools/e2e_camera.py [--live] [--limit N]
  (once) uv run --with playwright playwright install chromium

Serves the repo with python3 -m http.server, feeds each barcode to headless Chromium as a
fake camera (y4m), and asserts the debug panel (?debug=1) shows the canonical EAN-13 and
the name Lib.mapOffProduct() yields for the OFF snapshot. OFF is served from
test/fixtures/off-snapshot.json unless --live.
"""
import argparse, json, socket, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRAMES = 90
TIMEOUT_MS = 20000
DECODABLE = {"EAN_13", "EAN_8", "UPC_A"}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def load():
    prods = json.loads((ROOT / "test/fixtures/be-products.json").read_text())
    snap = json.loads((ROOT / "test/fixtures/off-snapshot.json").read_text())
    return prods, snap


def canonical(raw):
    """Canonical EAN via lib.js (same as the app) + expected name from snapshot."""
    js = ("const L=require('./lib.js');const i=JSON.parse(require('fs').readFileSync(0,'utf8'));"
          "console.log(JSON.stringify(i.map(x=>{const e=L.normalizeEan(x.ean,x.symbology);"
          "const s=x.snap;return {ean:e,name:s&&s.httpStatus===200?(L.mapOffProduct(s.body)||{}).name||'':''}})))")
    out = subprocess.run(["node", "-e", js], input=json.dumps(raw), cwd=ROOT, text=True,
                         capture_output=True, check=True).stdout
    return json.loads(out)


def select(prods, snap, limit):
    valid = [p for p in prods if p["expectValid"] and p["symbology"] in DECODABLE | {"UPC_E"}]
    picked, seen = [], set()

    def add(p, why):
        k = (p["ean"], p["store"])
        if k not in seen:
            seen.add(k)
            picked.append((p, why))

    def snap_of(p):
        return snap.get(canonical([{"ean": p["ean"], "symbology": p["symbology"]}])[0]["ean"])

    for sym in ["EAN_13", "EAN_8", "UPC_A", "UPC_E"]:
        c = [p for p in valid if p["symbology"] == sym and (sym == "UPC_E" or (snap_of(p) or {}).get("httpStatus") == 200)]
        if c:
            add(c[0], sym)
    for store in sorted({p["store"] for p in valid}):
        c = [p for p in valid if p["store"] == store and p["symbology"] == "EAN_13" and (snap_of(p) or {}).get("httpStatus") == 200]
        if c:
            add(c[0], "store " + store + (" (cross-store)" if c[0]["ean"] == "3017620422003" else ""))
    pl = [p for p in valid if p["privateLabel"] and p["symbology"] == "EAN_13" and (snap_of(p) or {}).get("httpStatus") == 200]
    if pl:
        add(pl[0], "private-label")
    nf = [p for p in valid if p["symbology"] == "EAN_13" and (snap_of(p) or {}).get("httpStatus") == 404]
    if nf:
        add(nf[0], "not-found")
    groups = {}
    for p in valid:
        if p["symbology"] == "EAN_13" and (snap_of(p) or {}).get("httpStatus") == 200:
            groups.setdefault(p["ean"], []).append(p)
    for ean, ps in groups.items():
        if len({p["store"] for p in ps}) > 1:
            add(ps[0], "cross-store A")
            add(next(p for p in ps if p["store"] != ps[0]["store"]), "cross-store B")
            break
    return picked[:limit] if limit else picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="use the real OFF API instead of the snapshot")
    ap.add_argument("--limit", type=int, default=0, help="only run the first N selected barcodes")
    args = ap.parse_args()
    from playwright.sync_api import sync_playwright

    t_start = time.time()
    prods, snap = load()
    chosen = select(prods, snap, args.limit)
    port = free_port()
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results = []
    try:
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp, sync_playwright() as pw:
            canon = canonical([{"ean": p["ean"], "symbology": p["symbology"],
                                "snap": snap.get(canonical([{"ean": p["ean"], "symbology": p["symbology"]}])[0]["ean"])}
                               for p, _ in chosen])
            for _ in range(50):
                try:
                    socket.create_connection(("127.0.0.1", port), 0.2).close()
                    break
                except OSError:
                    time.sleep(0.1)
            for (p, why), exp in zip(chosen, canon):
                y4m = Path(tmp) / f"{p['ean']}_{p['symbology']}.y4m"
                subprocess.run(["node", "tools/barcode-render.js", "y4m", p["ean"], p["symbology"], str(y4m), str(FRAMES)],
                               cwd=ROOT, check=True, capture_output=True)
                if p["symbology"] == "UPC_E":
                    results.append((why, p["ean"], p["symbology"], "SKIP", "UPC-E not decodable by vendored ZXing (expected)"))
                    continue
                snap_entry = snap.get(exp["ean"]) or {"httpStatus": 404, "body": {"code": exp["ean"], "status": 0, "status_verbose": "product not found"}}
                want_name = exp["name"]
                want_state = "off" if want_name else "unknown"
                browser = pw.chromium.launch(args=[
                    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                    f"--use-file-for-fake-video-capture={y4m}"])
                ctx = browser.new_context(permissions=["camera"], service_workers="block")
                page = ctx.new_page()
                if not args.live:
                    def handle(route, _req, snap_entry=snap_entry):
                        route.fulfill(status=404 if snap_entry["httpStatus"] != 200 else 200,
                                      content_type="application/json", body=json.dumps(snap_entry["body"]),
                                      headers={"access-control-allow-origin": "*"})
                    page.route("https://world.openfoodfacts.org/**", handle)
                msg = ""
                ok = False
                try:
                    page.goto(f"http://127.0.0.1:{port}/?debug=1")
                    page.click("#btn-start")
                    page.wait_for_function(
                        "() => { const s=document.querySelector('[data-testid=debug-state]').textContent;"
                        "return s && s !== 'looking up…'; }", timeout=TIMEOUT_MS)
                    g = lambda t: page.locator(f"[data-testid=debug-{t}]").inner_text().strip()
                    ean, name, state, fmt = g("ean"), g("name"), g("state"), g("format")
                    if args.live:
                        ok = ean == exp["ean"] and state in ("off", "unknown") and (state == "unknown" or bool(name))
                        msg = f"{fmt} {ean} {state} {name!r}" + ("" if name == want_name else f" (snapshot: {want_name!r})")
                    else:
                        ok = ean == exp["ean"] and name == want_name and state == want_state
                        msg = f"{fmt} {ean} {state} {name!r}"
                        if not ok:
                            msg += f" | expected {exp['ean']} {want_state} {want_name!r}"
                except Exception as e:  # noqa: BLE001
                    msg = "error: " + str(e).splitlines()[0]
                finally:
                    ctx.close()
                    browser.close()
                results.append((why, p["ean"], p["symbology"], "PASS" if ok else "FAIL", msg))
    finally:
        server.terminate()
        server.wait()

    w = max((len(r[0]) for r in results), default=5)
    print(f"{'case':<{w}}  {'barcode':<14} {'sym':<6} result  detail")
    for why, ean, sym, res, msg in results:
        print(f"{why:<{w}}  {ean:<14} {sym:<6} {res:<6}  {msg}")
    fails = sum(r[3] == "FAIL" for r in results)
    print(f"\n{sum(r[3]=='PASS' for r in results)} passed, {fails} failed, "
          f"{sum(r[3]=='SKIP' for r in results)} skipped in {time.time()-t_start:.1f}s")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
