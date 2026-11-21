#!/usr/bin/env python3
"""End-to-end two-phone inventory sync test against an in-memory fake GitHub Contents API.

  uv run --with playwright python tools/e2e_inventory.py
  (once) uv run --with playwright playwright install chromium

Two isolated browser contexts ("phone A"/"phone B") load the app served from the repo; OFF is
answered from test/fixtures/off-snapshot.json and api.github.com contents calls hit a shared fake.
"""
import base64, hashlib, json, re, socket, subprocess, sys, time
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
OWNER, REPO, TOKEN = "VLjoris", "food-scan-data", "fake-token-s3cr3t"
CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
}


class FakeGithub:
    def __init__(self):
        self.files = {}  # path -> (bytes, sha)
        self.puts = []

    @staticmethod
    def sha(b):
        return hashlib.sha1(b"blob %d\0" % len(b) + b).hexdigest()

    def handle(self, route, request):
        def reply(status, body=None):
            route.fulfill(status=status, content_type="application/json", headers=CORS,
                          body=json.dumps(body if body is not None else {}))

        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        u = urlparse(request.url)
        m = re.match(rf"^/repos/{OWNER}/{REPO}/contents/(.*)$", u.path)
        if not m:
            return reply(404, {"message": "Not Found"})
        path = unquote(m.group(1)).strip("/")
        if request.method == "GET":
            if path in self.files:
                data, sha = self.files[path]
                return reply(200, {"type": "file", "name": path.split("/")[-1], "path": path, "sha": sha,
                                   "encoding": "base64", "content": base64.b64encode(data).decode()})
            prefix = path + "/"
            kids = sorted({k[len(prefix):].split("/")[0] for k in self.files if k.startswith(prefix)})
            if not kids:
                return reply(404, {"message": "Not Found"})
            return reply(200, [{"type": "dir" if any(k.startswith(prefix + n + "/") for k in self.files) else "file",
                                "name": n, "path": prefix + n} for n in kids])
        if request.method == "PUT":
            body = json.loads(request.post_data or "{}")
            cur = self.files.get(path)
            if cur and body.get("sha") != cur[1]:
                return reply(409, {"message": "sha mismatch"})
            if not cur and body.get("sha"):
                return reply(422, {"message": "sha not supported"})
            data = base64.b64decode(body["content"])
            self.files[path] = (data, self.sha(data))
            self.puts.append(path)
            return reply(201 if not cur else 200, {"content": {"path": path, "sha": self.files[path][1]}})
        return reply(405, {"message": "method not allowed"})


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def pick_ean():
    snap = json.loads((ROOT / "test/fixtures/off-snapshot.json").read_text())
    js = ("const L=require('./lib.js');const s=JSON.parse(require('fs').readFileSync(0,'utf8'));"
          "for(const [e,v] of Object.entries(s)){if(v.httpStatus===200&&L.normalizeEan(e)){"
          "const m=L.mapOffProduct(v.body);if(m&&m.name){console.log(JSON.stringify({ean:e,name:m.name}));break}}}")
    out = subprocess.run(["node", "-e", js], input=json.dumps(snap), cwd=ROOT, text=True,
                         capture_output=True, check=True).stdout
    return json.loads(out), snap


def main():
    from playwright.sync_api import sync_playwright, expect

    t0 = time.time()
    pick, snap = pick_ean()
    ean, off_name = pick["ean"], pick["name"]
    port = free_port()
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                              cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    gh = FakeGithub()
    checks = []

    def check(label, cond, detail=""):
        checks.append((label, bool(cond), detail))
        print(("PASS " if cond else "FAIL ") + label + (f"  [{detail}]" if detail and not cond else ""))

    try:
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", port), 0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()

            def phone(name):
                ctx = browser.new_context(service_workers="block", permissions=["clipboard-read", "clipboard-write"])
                page = ctx.new_page()
                page.on("pageerror", lambda e, n=name: print(f"[{n}] pageerror: {e}"))
                page.route(re.compile(r"^https://api\.github\.com/repos/.*/contents/.*"), gh.handle)
                body = json.dumps(snap[ean]["body"])
                page.route("https://world.openfoodfacts.org/**",
                           lambda r: r.fulfill(status=200, content_type="application/json", body=body,
                                               headers={"access-control-allow-origin": "*"}))
                page.goto(f"http://127.0.0.1:{port}/")
                page.click("#tab-history")
                page.fill("#sync-owner", OWNER)
                page.fill("#sync-repo", REPO)
                page.fill("#sync-token", TOKEN)
                page.click("#sync-form button.primary")
                expect(page.locator("#sync-status")).to_contain_text("Last sync", timeout=10000)
                return page

            def sync(page):
                page.click("#tab-history")
                page.locator("#sync-status").evaluate("e => e.textContent = ''")
                page.click("#sync-now")
                expect(page.locator("#sync-status")).to_contain_text("Last sync", timeout=10000)
                err = page.locator("#sync-status").inner_text()
                assert "error" not in err.lower(), err

            def stock_rows(page):
                page.click("#tab-stock")
                return page.eval_on_selector_all(
                    "li.stock-row", "els => els.map(e => ({item: e.dataset.item, name: e.querySelector('.stock-name').textContent,"
                                    " count: e.querySelector('.stock-count').textContent}))")

            A, B = phone("A"), phone("B")

            def scan_plus(page):
                page.click("#tab-scan")
                page.click("#mode-in")
                page.fill("#manual-ean", ean)
                page.press("#manual-ean", "Enter")
                expect(page.locator("#r-count")).to_have_text("1", timeout=10000)

            scan_plus(A)
            scan_plus(B)
            sync(A); sync(B); sync(A); sync(B)
            for n, p in (("A", A), ("B", B)):
                rows = [r for r in stock_rows(p) if r["item"] == ean]
                check(f"{n} stock count is 2 after sync", rows and rows[0]["count"] == "2", str(rows))

            # rename on A via the result card (still showing the scanned item)
            A.click("#tab-scan")
            A.fill("#rn-name", "Mijn Cola")
            A.click("#rename button")
            expect(A.locator("#r-name")).to_have_text("Mijn Cola")
            check("A shows override badge", A.locator("#r-override").is_visible())
            sync(A); sync(B)
            rows = [r for r in stock_rows(B) if r["item"] == ean]
            check("B stock row has override name", rows and rows[0]["name"] == "Mijn Cola", str(rows))
            check("B stock count still 2", rows and rows[0]["count"] == "2", str(rows))
            B.click("#tab-scan")
            B.fill("#manual-ean", ean)
            B.click("#manual button")
            expect(B.locator("#r-name")).to_have_text("Mijn Cola", timeout=10000)
            check("B result card shows override badge", B.locator("#r-override").is_visible())
            B.click("#tab-history")
            check("B history shows override badge", B.locator("#list .badge").first.is_visible())
            B.click("#tab-stock")
            B.evaluate("""() => { window.__clip = null;
                navigator.clipboard.writeText = async t => { window.__clip = t; }; }""")
            B.click("#btn-copy-menu")
            B.wait_for_function("window.__clip !== null")
            clip = B.evaluate("window.__clip")
            check("B copy-menu text contains 'Mijn Cola'", "Mijn Cola" in clip, clip[:200])

            # non-barcode item added on B shows up on A
            B.click("#tab-stock")
            B.fill("#add-name", "Zelfgemaakte soep")
            B.click("#add-form button.primary")
            expect(B.locator("#stock-msg")).to_have_text("Added Zelfgemaakte soep")
            sync(B); sync(A)
            rows = [r for r in stock_rows(A) if r["name"] == "Zelfgemaakte soep"]
            check("A sees non-barcode item from B", rows and rows[0]["count"] == "1", str(rows))

            # feed + token
            feed = gh.files.get("feed/inventory.json")
            check("feed/inventory.json written", feed is not None)
            feed_txt = feed[0].decode() if feed else ""
            check("feed contains the item", "Mijn Cola" in feed_txt and "Zelfgemaakte soep" in feed_txt, feed_txt[:300])
            check("two device event files in repo",
                  len([k for k in gh.files if k.startswith("events/")]) == 2, str(list(gh.files)))
            for n, p in (("A", A), ("B", B)):
                for tab in ("scan", "stock", "history"):
                    p.click(f"#tab-{tab}")
                    txt = p.evaluate("document.body.innerText + document.body.textContent")
                    check(f"{n}/{tab}: token not in DOM text", TOKEN not in txt)
            browser.close()
    finally:
        server.terminate()
        server.wait()

    fails = [c for c in checks if not c[1]]
    print(f"\n{len(checks) - len(fails)} passed, {len(fails)} failed in {time.time() - t0:.1f}s (ean {ean} {off_name!r})")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
