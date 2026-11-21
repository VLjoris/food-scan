// Sync adapters (GitHub Contents API / generic HTTP) + syncOnce. No DOM, no deps.
const Sync = {
  utf8ToBase64(str) {
    if (typeof Buffer !== "undefined") return Buffer.from(str, "utf8").toString("base64");
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  },

  base64ToUtf8(b64) {
    b64 = String(b64 || "").replace(/\s/g, "");
    if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64").toString("utf8");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  },

  // Union by id (first seen wins), sorted by t, dev, id.
  mergeEvents(a, b) {
    const byId = new Map();
    for (const e of [...(a || []), ...(b || [])]) if (e && e.id != null && !byId.has(e.id)) byId.set(e.id, e);
    const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    return [...byId.values()].sort((x, y) => cmp(x.t, y.t) || cmp(x.dev, y.dev) || cmp(x.id, y.id));
  },

  makeError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
  },

  httpError(res, what) {
    const s = res.status;
    let msg;
    if (s === 401) msg = "Invalid or expired token";
    else if (s === 403) msg = "Access denied (403): check the token has Contents read/write permission for the repo";
    else if (s === 404) msg = "Not found (404): check owner/repo name and that the token can access the repository";
    else msg = `${what} failed (HTTP ${s})`;
    return Sync.makeError(s, msg);
  },

  createGithubAdapter({ owner, repo, token, fetch = globalThis.fetch, branch = "main" }) {
    const base = `https://api.github.com/repos/${owner}/${repo}/contents/`;
    const headers = () => ({
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
    const call = (method, path, body) =>
      fetch(base + enc(path) + (method === "GET" ? `?ref=${encodeURIComponent(branch)}` : ""), {
        method,
        headers: body ? { ...headers(), "Content-Type": "application/json" } : headers(),
        cache: "no-store",
        body: body ? JSON.stringify(body) : undefined,
      });

    // -> {sha, text} or null when missing
    async function getFile(path) {
      const res = await call("GET", path);
      if (res.status === 404) return null;
      if (!res.ok) throw Sync.httpError(res, "Read " + path);
      const j = await res.json();
      let content = j.content;
      if (j.encoding !== "base64" || content == null) {
        // large files: content omitted, fall back to raw
        const raw = await fetch(base + enc(path) + `?ref=${encodeURIComponent(branch)}`, {
          headers: { ...headers(), Accept: "application/vnd.github.raw+json" },
          cache: "no-store",
        });
        if (!raw.ok) throw Sync.httpError(raw, "Read " + path);
        return { sha: j.sha, text: await raw.text() };
      }
      return { sha: j.sha, text: Sync.base64ToUtf8(content) };
    }

    // Equal ignoring the volatile generatedAt field
    function same(a, b) {
      if (a === b) return true;
      try {
        const strip = (t) => { const o = JSON.parse(t); if (o && typeof o === "object" && !Array.isArray(o)) delete o.generatedAt; return JSON.stringify(o); };
        return strip(a) === strip(b);
      } catch {
        return false;
      }
    }

    async function putFile(path, text, message) {
      let existing = await getFile(path);
      if (existing && same(existing.text, text)) return false;
      for (let attempt = 0; ; attempt++) {
        const body = { message, content: Sync.utf8ToBase64(text), branch };
        if (existing) body.sha = existing.sha;
        const res = await call("PUT", path, body);
        if (res.ok) return true;
        if ((res.status === 409 || res.status === 422) && attempt === 0) {
          existing = await getFile(path);
          if (existing && same(existing.text, text)) return false;
          continue;
        }
        throw Sync.httpError(res, "Write " + path);
      }
    }

    return {
      async pull() {
        const res = await call("GET", "events");
        if (res.status === 404) return [];
        if (!res.ok) throw Sync.httpError(res, "List events");
        const list = await res.json();
        const files = (Array.isArray(list) ? list : []).filter((f) => f.type !== "dir" && /\.json$/.test(f.name));
        const out = [];
        const files_ = new Map(); // event id -> device files containing it
        for (const f of files) {
          const file = await getFile("events/" + f.name);
          if (!file) continue;
          try {
            const arr = JSON.parse(file.text);
            if (Array.isArray(arr)) {
              out.push(...arr);
              const name = f.name.replace(/\.json$/, "");
              for (const e of arr) if (e && e.id != null) (files_.get(e.id) || files_.set(e.id, new Set()).get(e.id)).add(name);
            }
          } catch {
            // ignore corrupt file
          }
        }
        Object.defineProperty(out, "owners", { value: files_, enumerable: false });
        return out;
      },
      push(deviceId, myEvents) {
        return putFile(`events/${deviceId}.json`, JSON.stringify(myEvents), `sync ${deviceId}`);
      },
      writeFeed(obj) {
        return putFile("feed/inventory.json", JSON.stringify(obj, null, 2), "update inventory feed");
      },
    };
  },

  createHttpAdapter({ baseUrl, token, fetch = globalThis.fetch }) {
    const root = String(baseUrl).replace(/\/+$/, "");
    const hdrs = (json) => {
      const h = { Accept: "application/json" };
      if (token) h.Authorization = `Bearer ${token}`;
      if (json) h["Content-Type"] = "application/json";
      return h;
    };
    async function put(path, body, what) {
      const res = await fetch(root + path, { method: "PUT", headers: hdrs(true), body: JSON.stringify(body) });
      if (!res.ok) throw Sync.httpError(res, what);
      return true;
    }
    return {
      async pull() {
        const res = await fetch(root + "/api/events", { headers: hdrs(false), cache: "no-store" });
        if (res.status === 404) return [];
        if (!res.ok) throw Sync.httpError(res, "Pull");
        const j = await res.json();
        return Array.isArray(j) ? j : [];
      },
      push: (deviceId, myEvents) => put(`/api/events/${encodeURIComponent(deviceId)}`, myEvents, "Push"),
      writeFeed: (obj) => put("/api/feed", obj, "Write feed"),
    };
  },

  async syncOnce({ adapter, deviceId, localEvents, writeFeed }) {
    const remote = await adapter.pull();
    const merged = Sync.mergeEvents(localEvents, remote);
    // Own events plus foreign events (e.g. restored from a backup) that no other device's file holds
    const owners = remote.owners;
    const mine = merged.filter((e) => {
      if (e.dev === deviceId) return true;
      if (!owners) return true;
      const o = owners.get(e.id);
      return !o || o.has(deviceId);
    });
    const pushed = await adapter.push(deviceId, mine);
    const result = { merged, pulled: remote.length, pushed };
    if (typeof writeFeed === "function") {
      try {
        await adapter.writeFeed(await writeFeed(merged));
      } catch (e) {
        result.feedError = e;
      }
    }
    return result;
  },
};
if (typeof module !== "undefined") module.exports = Sync;
