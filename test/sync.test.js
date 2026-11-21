const assert = require("assert");
const Sync = require("../sync.js");

function fakeGithub({ token = "tok" } = {}) {
  const files = new Map(); // path -> {text, sha}
  let n = 0;
  const log = [];
  const forceConflict = { count: 0 };
  const res = (status, body) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/repos\/o\/r\/contents\/(.*)$/);
    const path = decodeURIComponent(m[1]);
    const method = opts.method || "GET";
    log.push(method + " " + path);
    if (opts.headers.Authorization !== "Bearer " + token) return res(401, { message: "Bad credentials" });
    if (method === "GET") {
      if (files.has(path)) {
        const f = files.get(path);
        return res(200, { type: "file", name: path.split("/").pop(), sha: f.sha, encoding: "base64", content: Buffer.from(f.text).toString("base64") });
      }
      const prefix = path + "/";
      const kids = [...files.keys()].filter((k) => k.startsWith(prefix));
      if (!kids.length) return res(404, { message: "Not Found" });
      return res(200, kids.map((k) => ({ type: "file", name: k.slice(prefix.length) })));
    }
    const body = JSON.parse(opts.body);
    const cur = files.get(path);
    if (forceConflict.count > 0) {
      forceConflict.count--;
      return res(409, {});
    }
    if (cur && body.sha !== cur.sha) return res(409, {});
    if (!cur && body.sha) return res(422, {});
    files.set(path, { text: Buffer.from(body.content, "base64").toString("utf8"), sha: "sha" + ++n });
    return res(cur ? 200 : 201, {});
  };
  return { fetch, files, log, forceConflict };
}

const ev = (id, t, dev, extra = {}) => ({ id, t, dev, ...extra });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const mk = (gh, extra = {}) => Sync.createGithubAdapter({ owner: "o", repo: "r", token: "tok", fetch: gh.fetch, ...extra });

test("empty repo pull", async () => {
  assert.deepStrictEqual(await mk(fakeGithub()).pull(), []);
});

test("first push creates, second updates with sha", async () => {
  const gh = fakeGithub();
  const a = mk(gh);
  assert.strictEqual(await a.push("d1", [ev("1", 1, "d1")]), true);
  assert.ok(gh.files.has("events/d1.json"));
  assert.strictEqual(await a.push("d1", [ev("1", 1, "d1"), ev("2", 2, "d1")]), true);
  assert.strictEqual(JSON.parse(gh.files.get("events/d1.json").text).length, 2);
  assert.strictEqual(await a.push("d1", [ev("1", 1, "d1"), ev("2", 2, "d1")]), false); // unchanged: no PUT
  assert.strictEqual(gh.log.filter((l) => l.startsWith("PUT")).length, 2);
});

test("conflict retries once, then fails", async () => {
  const gh = fakeGithub();
  const a = mk(gh);
  await a.push("d1", []);
  gh.forceConflict.count = 1;
  assert.strictEqual(await a.push("d1", [ev("1", 1, "d1")]), true);
  gh.forceConflict.count = 2;
  await assert.rejects(() => a.push("d1", [ev("2", 2, "d1")]), (e) => e.status === 409);
});

test("two devices converge", async () => {
  const gh = fakeGithub();
  const A = mk(gh), B = mk(gh);
  let la = [ev("a1", 1, "A")], lb = [ev("b1", 2, "B")];
  la = (await Sync.syncOnce({ adapter: A, deviceId: "A", localEvents: la })).merged;
  lb = (await Sync.syncOnce({ adapter: B, deviceId: "B", localEvents: lb })).merged;
  la = (await Sync.syncOnce({ adapter: A, deviceId: "A", localEvents: la, writeFeed: () => ({ items: 2 }) })).merged;
  assert.deepStrictEqual(la.map((e) => e.id), ["a1", "b1"]);
  assert.deepStrictEqual(lb, la);
  assert.deepStrictEqual(JSON.parse(gh.files.get("events/A.json").text).map((e) => e.id), ["a1"]);
  assert.deepStrictEqual(JSON.parse(gh.files.get("feed/inventory.json").text), { items: 2 });
});

test("feed errors are swallowed", async () => {
  const gh = fakeGithub();
  const r = await Sync.syncOnce({ adapter: mk(gh), deviceId: "A", localEvents: [], writeFeed: () => { throw new Error("x"); } });
  assert.strictEqual(r.feedError.message, "x");
});

test("unicode roundtrip", async () => {
  const gh = fakeGithub();
  const a = mk(gh);
  const name = "Crème brûlée 🍮 — 日本語";
  await a.push("d1", [ev("1", 1, "d1", { name })]);
  assert.strictEqual((await a.pull())[0].name, name);
});

test("401 message", async () => {
  const gh = fakeGithub();
  const a = Sync.createGithubAdapter({ owner: "o", repo: "r", token: "bad", fetch: gh.fetch });
  await assert.rejects(() => a.pull(), (e) => e.status === 401 && /Invalid or expired token/.test(e.message));
});

test("http adapter roundtrip", async () => {
  const store = {};
  const fetch = async (url, o = {}) => {
    const p = url.replace("http://h", "");
    const ok = (b) => ({ status: 200, ok: true, json: async () => b });
    if ((o.method || "GET") === "GET" && p === "/api/events") return ok(Object.values(store).flat());
    store[p] = JSON.parse(o.body);
    return ok({});
  };
  const a = Sync.createHttpAdapter({ baseUrl: "http://h/", fetch });
  await a.push("d1", [ev("1", 1, "d1")]);
  await a.writeFeed({ f: 1 });
  assert.ok(store["/api/feed"]);
  assert.deepStrictEqual((await a.pull()).map((e) => e.id).filter(Boolean), ["1"]);
});

test("second syncOnce with no changes makes no feed/events PUT", async () => {
  const gh = fakeGithub();
  const a = mk(gh);
  const local = [ev("1", 1, "d1")];
  const wf = async () => ({ generatedAt: Date.now() + Math.random(), rows: [] });
  await Sync.syncOnce({ adapter: a, deviceId: "d1", localEvents: local, writeFeed: wf });
  gh.log.length = 0;
  await Sync.syncOnce({ adapter: a, deviceId: "d1", localEvents: local, writeFeed: wf });
  assert.deepStrictEqual(gh.log.filter((l) => l.startsWith("PUT")), []);
});

test("foreign events only held locally propagate via this device's file", async () => {
  const gh = fakeGithub();
  const a = mk(gh);
  const local = [ev("x1", 1, "X"), ev("d1a", 2, "d1")];
  await Sync.syncOnce({ adapter: a, deviceId: "d1", localEvents: local });
  const r2 = await Sync.syncOnce({ adapter: a, deviceId: "d2", localEvents: [] });
  assert.deepStrictEqual(r2.merged.map((e) => e.id).sort(), ["d1a", "x1"]);
  // still kept in d1's file on later syncs
  await Sync.syncOnce({ adapter: a, deviceId: "d1", localEvents: r2.merged });
  assert.ok(JSON.parse(gh.files.get("events/d1.json").text).some((e) => e.id === "x1"));
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); }
    catch (e) { fail++; console.log("FAIL " + name + "\n" + e.stack); }
  }
  process.exit(fail ? 1 : 0);
})();
