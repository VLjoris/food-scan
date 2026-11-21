// Local DB (IndexedDB v2): "products" (OFF cache, keyed by ean, not synced), "events" (synced log), "meta" (deviceId, seq, sync, scanMode).
// product: { ean, name, brand, quantity, category, source: "off"|"manual", scans, firstSeen, lastSeen }
const DB_NAME = "be-food-scan";
const OFF_URL = "https://world.openfoodfacts.org/api/v2/product/";
const OFF_FIELDS = "code,product_name,product_name_nl,product_name_fr,product_name_en,generic_name,brands,quantity,image_front_url,categories_tags";

const $ = id => document.getElementById(id);
const db = new Promise((res, rej) => {
  const r = indexedDB.open(DB_NAME, 2);
  r.onupgradeneeded = () => {
    const d = r.result;
    if (!d.objectStoreNames.contains("products")) d.createObjectStore("products", { keyPath: "ean" });
    if (!d.objectStoreNames.contains("events")) d.createObjectStore("events", { keyPath: "id" });
    if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "key" });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  const d = await db;
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out?.result);
    t.onerror = () => rej(t.error);
  });
}
const dbGet = ean => tx("products", "readonly", s => s.get(ean));
const dbPut = rec => tx("products", "readwrite", s => s.put(rec));
const dbDel = ean => tx("products", "readwrite", s => s.delete(ean));
const dbAll = () => tx("products", "readonly", s => s.getAll());
const evAll = () => tx("events", "readonly", s => s.getAll());
const evPutMany = evs => tx("events", "readwrite", s => { evs.forEach(e => s.put(e)); });
const metaGet = async key => (await tx("meta", "readonly", s => s.get(key)))?.value;
const metaSet = (key, value) => tx("meta", "readwrite", s => s.put({ key, value }));

let devicePromise;
function getDeviceId() {
  return devicePromise ||= (async () => {
    let id = await metaGet("deviceId");
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
      await metaSet("deviceId", id);
    }
    return id;
  })();
}
let seqChain = Promise.resolve();
function nextSeq() {
  const p = seqChain.then(async () => { const n = (await metaGet("seq") || 0) + 1; await metaSet("seq", n); return n; });
  seqChain = p.catch(() => {});
  return p;
}

// ---- Event state ----
let state = { stock: {}, names: {} };
let productsByEan = {};
async function refreshState() {
  const [evs, prods] = await Promise.all([evAll(), dbAll()]);
  state = Lib.reduceEvents(evs);
  productsByEan = Object.fromEntries(prods.map(p => [p.ean, p]));
  renderAll();
}
async function addEvent(type, fields) {
  const dev = await getDeviceId();
  const ev = Lib.makeEvent(dev, await nextSeq(), type, fields);
  await evPutMany([ev]);
  await refreshState();
  scheduleSync();
  return ev;
}
const resolve = item => Lib.resolveItem(item, state, productsByEan[item]);

// One-time: manual products from v1 become name events.
async function migrateManual() {
  if (await metaGet("migratedManual")) return;
  const dev = await getDeviceId();
  const evs = [];
  for (const p of await dbAll()) {
    if (p.source === "manual" && p.ean && p.name) {
      evs.push(Lib.makeEvent(dev, await nextSeq(), "name", { item: p.ean, name: p.name, category: p.category || "" }, p.firstSeen || Date.now()));
    }
  }
  await evPutMany(evs);
  await metaSet("migratedManual", true);
}

navigator.storage?.persist?.(); // ask iOS not to evict our data

async function fetchOff(ean, info = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(`${OFF_URL}${ean}.json?fields=${OFF_FIELDS}`, { signal: ctl.signal });
    info.status = r.status;
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    info.raw = j.product || j;
    const m = Lib.mapOffProduct(j);
    info.mapped = m;
    if (!m || !m.name) return null;
    return { name: m.name, brand: m.brand, quantity: m.quantity, category: m.category };
  } finally {
    clearTimeout(timer);
  }
}

// Returns { rec, state: "local"|"off"|"unknown"|"offline" }
async function lookup(ean, info = {}) {
  const now = Date.now();
  const local = await dbGet(ean);
  if (local) {
    local.scans = (local.scans || 0) + 1;
    local.lastSeen = now;
    await dbPut(local);
    info.state = "local";
    return { rec: local, state: "local" };
  }
  let off;
  try {
    off = await fetchOff(ean, info);
  } catch (e) {
    info.error = e.message;
    info.state = "offline";
    return { rec: { ean }, state: "offline" }; // don't prompt for a name when we just have no network
  }
  if (!off) { info.state = "unknown"; return { rec: { ean }, state: "unknown" }; }
  const rec = { ean, ...off, source: "off", scans: 1, firstSeen: now, lastSeen: now };
  await dbPut(rec);
  info.state = "off";
  return { rec, state: "off" };
}

// ---- UI ----
let busy = false;
let lastEan = "", lastAt = 0;

let current = null; // product rec shown in the result card
let scanMode = "look";
const MODES = { look: "mode-look", in: "mode-in", out: "mode-out" };

function fillCategories(sel) {
  sel.replaceChildren(...Lib.CATEGORIES.map(c => new Option(c.label, c.key)));
  sel.value = "other";
}
["rn-cat", "u-cat", "add-cat"].forEach(id => fillCategories($(id)));

function setMode(m) {
  scanMode = MODES[m] ? m : "look";
  for (const [k, id] of Object.entries(MODES)) $(id).classList.toggle("active", k === scanMode);
  try { localStorage.setItem("scanMode", scanMode); } catch {}
  metaSet("scanMode", scanMode);
}
for (const [k, id] of Object.entries(MODES)) $(id).onclick = () => setMode(k);

// Applies a stock delta; -1 is blocked at 0. Returns the new count or null when blocked.
let stockChain = Promise.resolve();
function changeStock(item, delta) {
  const p = stockChain.then(async () => {
    if (delta < 0 && resolve(item).count <= 0) return null;
    await addEvent("stock", { item, delta });
    return resolve(item).count;
  });
  stockChain = p.catch(() => {});
  return p;
}

function renderResult() {
  if (!current) return;
  const r = resolve(current.ean);
  $("r-name").textContent = r.name;
  $("r-override").hidden = !r.isOverride;
  $("r-count").textContent = r.count;
  $("r-minus").disabled = r.count <= 0;
}

function show(rec, st) {
  $("result").hidden = st === "unknown" || st === "offline";
  $("unknown").hidden = st !== "unknown";
  if (st === "unknown") {
    $("u-ean").textContent = rec.ean + (Lib.isBelgianPrefix(rec.ean) ? " · BE" : "");
    $("u-name").value = "";
    $("u-brand").value = "";
    $("u-cat").value = "other";
    $("u-name").focus();
    return;
  }
  if (st === "offline") { $("status").textContent = "No network — can't look up " + rec.ean + ". Try again."; return; }
  current = rec;
  $("r-ean").textContent = rec.ean + (Lib.isBelgianPrefix(rec.ean) ? " · BE" : "");
  $("r-meta").textContent = [rec.brand, rec.quantity].filter(Boolean).join(" · ");
  $("r-source").textContent = rec.source === "manual" ? "entered by you" : "Open Food Facts";
  const r = resolve(rec.ean);
  $("rn-name").value = r.isOverride ? r.name : "";
  $("rn-cat").value = Lib.CATEGORIES.some(c => c.key === r.category) ? r.category : "other";
  renderResult();
}

$("r-minus").onclick = async () => {
  const n = await changeStock(current.ean, -1);
  $("status").textContent = n == null ? "Stock is already 0" : "−1 · now " + n;
};
$("r-plus").onclick = async () => { $("status").textContent = "+1 · now " + await changeStock(current.ean, 1); };
$("rename").addEventListener("submit", async e => {
  e.preventDefault();
  await addEvent("name", { item: current.ean, name: $("rn-name").value.trim(), category: $("rn-cat").value });
  $("status").textContent = $("rn-name").value.trim() ? "Renamed ✔" : "Override cleared";
});

async function applyMode(item) {
  if (scanMode === "look") return "";
  const n = await changeStock(item, scanMode === "in" ? 1 : -1);
  return n == null ? " · stock is already 0" : (scanMode === "in" ? " · +1" : " · −1") + " → " + n;
}

// ---- Debug panel (?debug=1 persists, ?debug=0 disables) ----
const dbgParam = new URLSearchParams(location.search).get("debug");
try {
  if (dbgParam === "1") localStorage.setItem("debug", "1");
  else if (dbgParam === "0") localStorage.removeItem("debug");
} catch {}
const DEBUG = dbgParam === "1" || (dbgParam !== "0" && (() => { try { return localStorage.getItem("debug") === "1"; } catch { return false; } })());
if (DEBUG) $("debug").hidden = false;

function debugUpdate(d) {
  if (!DEBUG) return;
  const set = (id, v) => { $(id).textContent = v == null ? "" : String(v); };
  set("debug-raw", d.raw);
  set("debug-format", d.format || "");
  set("debug-ean", d.ean || (d.reject ? "rejected: " + d.reject : ""));
  set("debug-state", d.state || "");
  set("debug-name", d.name || "");
  const flags = d.ean ? ["BE: " + Lib.isBelgianPrefix(d.ean), "variable-weight: " + Lib.isVariableWeight(d.ean)] : [];
  set("debug-flags", flags.join(" · "));
  set("debug-http", d.status ?? "");
  set("debug-latency", d.latency == null ? "" : d.latency + " ms");
  set("debug-mapped", d.mapped ? JSON.stringify(d.mapped, null, 1) : "");
  set("debug-rawoff", d.rawOff ? JSON.stringify(d.rawOff, null, 1) : "");
}

async function handleCode(raw, format) {
  const ean = Lib.normalizeEan(raw, format);
  if (!ean) {
    $("status").textContent = "Invalid barcode: " + raw;
    debugUpdate({ raw, format, reject: "invalid length or checksum" });
    return;
  }
  if (busy || (ean === lastEan && Date.now() - lastAt < 3000)) return;
  busy = true; lastEan = ean; lastAt = Date.now();
  $("status").textContent = "Looking up " + ean + "…";
  const info = {};
  const t0 = performance.now();
  debugUpdate({ raw, format, ean, state: "looking up…" });
  try {
    const { rec, state } = await lookup(ean, info);
    debugUpdate({ raw, format, ean, state, name: rec.name, status: info.status, latency: Math.round(performance.now() - t0), mapped: info.mapped, rawOff: info.raw });
    const found = state === "off" ? "Found online ✔" : state === "local" ? "Found in local DB ✔" : "";
    if (state !== "offline" && state !== "unknown") navigator.vibrate?.(60);
    if (state === "off" || state === "local") await refreshState(); // products cache changed
    show(rec, state);
    if (state === "unknown") pendingEan = ean;
    if (state === "off" || state === "local") {
      const fb = await applyMode(ean);
      $("status").textContent = found + fb;
    } else if (state === "offline") {
      $("status").textContent += await applyMode(ean);
    } else $("status").textContent = found;
  } catch (e) {
    $("status").textContent = "Error: " + e.message;
    debugUpdate({ raw, format, ean, state: "error: " + e.message });
  } finally {
    busy = false;
  }
}
let pendingEan = null;

$("unknown").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("u-name").value.trim();
  if (!name || !pendingEan) return;
  const now = Date.now(), ean = pendingEan, category = $("u-cat").value;
  const rec = { ean, name, brand: $("u-brand").value.trim(), quantity: "", category, source: "manual", scans: 1, firstSeen: now, lastSeen: now };
  await dbPut(rec);
  pendingEan = null;
  await addEvent("name", { item: ean, name, category });
  show(rec, "local");
  $("status").textContent = "Saved ✔" + await applyMode(ean);
});
$("u-cancel").onclick = () => { pendingEan = null; $("unknown").hidden = true; };

$("manual").addEventListener("submit", e => {
  e.preventDefault();
  handleCode($("manual-ean").value);
  $("manual-ean").value = "";
});

// ---- Camera / scanning ----
let reader, track;
const { BrowserMultiFormatReader, DecodeHintType, BarcodeFormat } = ZXing;

async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) { $("status").textContent = "Camera needs HTTPS."; return; }
  const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, Lib.SCAN_FORMATS.map(n => BarcodeFormat[n])], [DecodeHintType.TRY_HARDER, true]]);
  reader = new BrowserMultiFormatReader(hints, 150);
  // ZXing's video auto-invert + TRY_HARDER's inverted retry can lock every scan onto inverted frames (never decodes).
  reader.createBinaryBitmap = function (video) {
    this.getCaptureCanvasContext(video);
    this.drawFrameOnCanvas(video);
    const src = new ZXing.HTMLCanvasElementLuminanceSource(this.getCaptureCanvas(video), false);
    return new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
  };
  try {
    await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      "video",
      res => { if (res) handleCode(res.getText(), BarcodeFormat[res.getBarcodeFormat()]); }
    );
    $("btn-start").textContent = "Stop camera";
    $("status").textContent = "Point at a barcode…";
    track = $("video").srcObject?.getVideoTracks?.()[0];
    $("btn-torch").hidden = !track?.getCapabilities?.().torch;
  } catch (e) {
    reader = null;
    $("status").textContent = "Camera error: " + (e.name === "NotAllowedError" ? "permission denied (iOS Settings › Safari › Camera)" : e.message);
  }
}
function stopScan() {
  reader?.reset(); reader = null; track = null;
  $("btn-start").textContent = "Start camera";
  $("btn-torch").hidden = true;
}
let torchOn = false;
$("btn-torch").onclick = async () => {
  torchOn = !torchOn;
  try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch {}
};
$("btn-start").onclick = () => (reader ? stopScan() : startScan());
document.addEventListener("visibilitychange", () => { if (document.hidden && reader) stopScan(); });

// ---- Tabs ----
const TABS = ["scan", "stock", "history"];
function switchTab(name) {
  for (const t of TABS) {
    $("view-" + t).hidden = t !== name;
    $("tab-" + t).classList.toggle("active", t === name);
  }
  if (name !== "scan") stopScan();
  renderAll();
}
for (const t of TABS) $("tab-" + t).onclick = () => switchTab(t);
const visible = name => !$("view-" + name).hidden;

function renderAll() {
  renderResult();
  if (visible("stock")) renderStock();
  if (visible("history")) renderHistory();
}

// ---- Stock tab ----
const stockRows = () => Lib.inventoryRows(state, productsByEan, { includeZero: $("stock-show-empty").checked });
const stockMsg = t => { $("stock-msg").textContent = t; };

function renderStock() {
  const rows = stockRows();
  const root = $("stock-list");
  const out = [];
  for (const c of Lib.CATEGORIES) {
    const g = rows.filter(r => (Lib.CATEGORIES.some(x => x.key === r.category) ? r.category : "other") === c.key);
    if (!g.length) continue;
    const h = document.createElement("h3");
    h.textContent = c.label;
    const ul = document.createElement("ul");
    ul.append(...g.map(r => {
      const li = document.createElement("li");
      li.className = "stock-row";
      li.dataset.item = r.item;
      const name = document.createElement("span");
      name.className = "stock-name"; name.textContent = r.name;
      const count = document.createElement("b");
      count.className = "stock-count"; count.textContent = r.count;
      const minus = document.createElement("button");
      minus.className = "stock-minus"; minus.textContent = "−"; minus.disabled = r.count <= 0;
      minus.onclick = () => changeStock(r.item, -1);
      const plus = document.createElement("button");
      plus.className = "stock-plus"; plus.textContent = "+";
      plus.onclick = () => changeStock(r.item, 1);
      li.append(name, minus, count, plus);
      return li;
    }));
    out.push(h, ul);
  }
  if (!out.length) { const p = document.createElement("p"); p.className = "status"; p.textContent = "Nothing in stock yet."; out.push(p); }
  root.replaceChildren(...out);
  $("btn-share").hidden = !navigator.share;
}
$("stock-show-empty").onchange = renderStock;

$("add-form").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("add-name").value.trim();
  if (!name) return;
  const item = Lib.itemIdForName(name);
  await addEvent("name", { item, name, category: $("add-cat").value });
  await changeStock(item, 1);
  $("add-name").value = "";
  stockMsg("Added " + name);
});

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand?.("copy");
    ta.remove();
    if (!ok) { stockMsg("Copy failed"); return; }
  }
  stockMsg(okMsg);
}
const menuText = () => Lib.menuText(Lib.inventoryRows(state, productsByEan));
const inventoryJson = () => JSON.stringify(Lib.inventoryJson(Lib.inventoryRows(state, productsByEan)), null, 1);
$("btn-copy-menu").onclick = () => copyText(menuText(), "Copied menu prompt");
$("btn-copy-json").onclick = () => copyText(inventoryJson(), "Copied JSON");
$("btn-dl-json").onclick = () => download("inventory.json", "application/json", inventoryJson());
$("btn-share").onclick = () => navigator.share({ title: "Inventory", text: menuText() }).catch(() => {});

// ---- History / export ----
function renderHistory() {
  const q = $("filter").value.trim().toLowerCase();
  const all = Object.values(productsByEan).sort((a, b) => b.lastSeen - a.lastSeen)
    .map(r => ({ r, res: resolve(r.ean) }))
    .filter(({ r, res }) => !q || (res.name + " " + r.name + " " + r.brand + " " + r.ean).toLowerCase().includes(q));
  $("list").replaceChildren(...all.map(({ r, res }) => {
    const li = document.createElement("li");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕";
    del.onclick = async () => { if (confirm("Delete " + res.name + "?")) { await dbDel(r.ean); await refreshState(); } };
    const b = document.createElement("b"); b.textContent = res.name;
    li.append(del, b);
    if (res.isOverride) {
      const o = document.createElement("span");
      o.className = "badge"; o.textContent = "override";
      li.append(" ", o);
    }
    const s = document.createElement("small");
    s.textContent = [r.ean, r.brand, r.quantity, r.source === "manual" ? "manual" : "OFF", "×" + r.scans].filter(Boolean).join(" · ");
    li.append(s);
    return li;
  }));
}
$("filter").oninput = renderHistory;

function download(name, type, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$("btn-csv").onclick = async () => {
  const rows = (await dbAll()).sort((a, b) => a.name.localeCompare(b.name));
  const head = ["ean", "name", "brand", "quantity", "source", "scans"];
  const csv = [head.join(","), ...rows.map(r => head.map(h => Lib.csvEscape(r[h])).join(","))].join("\n");
  download("products.csv", "text/csv", "\ufeff" + csv);
};
$("btn-backup").onclick = async () => download("be-food-scan-backup.json", "application/json",
  JSON.stringify({ version: 2, products: await dbAll(), events: await evAll() }, null, 1));
const isStr = v => typeof v === "string" && v !== "";
const validProduct = r => r && isStr(r.ean) && isStr(r.name);
const validEvent = e => e && isStr(e.id) && isStr(e.type) && isStr(e.item);
$("file-restore").onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const prods = Array.isArray(data) ? data : data?.products;
    const evs = Array.isArray(data) ? [] : data?.events;
    if (!Array.isArray(prods) || (evs !== undefined && !Array.isArray(evs))) throw new Error("not a backup file");
    const okP = prods.filter(validProduct), okE = (evs || []).filter(validEvent);
    for (const r of okP) await dbPut(r);
    await evPutMany(okE);
    await refreshState();
    scheduleSync();
    alert(`Restored ${okP.length} products, ${okE.length} events` +
      (okP.length < prods.length || okE.length < (evs || []).length ? ` (skipped ${prods.length - okP.length + (evs || []).length - okE.length} invalid)` : ""));
  } catch (err) { alert("Restore failed: " + err.message); }
  e.target.value = "";
};

// ---- Sync ----
let syncCfg = {};
let syncTimer, syncing = false, resync = false;
const syncReady = () => !!(syncCfg.owner && syncCfg.repo && syncCfg.token);

function renderSync() {
  $("sync-owner").value = syncCfg.owner || "";
  $("sync-repo").value = syncCfg.repo || "";
  $("sync-token").value = syncCfg.token || "";
  $("sync-label").value = syncCfg.label || "";
  $("sync-now").disabled = !syncReady();
  $("sync-status").textContent = !syncReady() ? "Sync not configured"
    : syncCfg.lastError ? "Sync error: " + syncCfg.lastError
    : syncCfg.lastSync ? "Last sync: " + new Date(syncCfg.lastSync).toLocaleString() : "Not synced yet";
}
$("sync-form").addEventListener("submit", async e => {
  e.preventDefault();
  syncCfg = { ...syncCfg, owner: $("sync-owner").value.trim(), repo: $("sync-repo").value.trim(), token: $("sync-token").value.trim(), label: $("sync-label").value.trim(), lastError: "" };
  await metaSet("sync", syncCfg);
  renderSync();
  syncNow();
});
$("sync-now").onclick = () => syncNow();

function scheduleSync() {
  if (!syncReady()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, 3000);
}
async function syncNow() {
  if (!syncReady()) return;
  clearTimeout(syncTimer);
  if (syncing) { resync = true; return; }
  syncing = true;
  $("sync-status").textContent = "Syncing…";
  try {
    const adapter = Sync.createGithubAdapter({ owner: syncCfg.owner, repo: syncCfg.repo, token: syncCfg.token });
    const r = await Sync.syncOnce({
      adapter, deviceId: await getDeviceId(), localEvents: await evAll(),
      writeFeed: merged => Lib.inventoryJson(Lib.inventoryRows(Lib.reduceEvents(merged), productsByEan)),
    });
    await evPutMany(r.merged);
    syncCfg = { ...syncCfg, lastSync: Date.now(), lastError: r.feedError ? "feed: " + r.feedError.message : "" };
  } catch (e) {
    syncCfg = { ...syncCfg, lastError: e.message || String(e) };
  }
  await metaSet("sync", syncCfg);
  syncing = false;
  await refreshState();
  renderSync();
  if (resync) { resync = false; scheduleSync(); }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });

// ---- Init ----
(async () => {
  await getDeviceId();
  await migrateManual();
  try { setMode(localStorage.getItem("scanMode") || await metaGet("scanMode") || "look"); } catch { setMode("look"); }
  syncCfg = (await metaGet("sync")) || {};
  renderSync();
  await refreshState();
  syncNow();
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
