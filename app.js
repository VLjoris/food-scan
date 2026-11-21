// Local DB (IndexedDB): store "products" keyed by ean.
// record: { ean, name, brand, quantity, source: "off"|"manual", scans, firstSeen, lastSeen }
const DB_NAME = "be-food-scan";
const OFF_URL = "https://world.openfoodfacts.org/api/v2/product/";
const OFF_FIELDS = "code,product_name,product_name_nl,product_name_fr,product_name_en,generic_name,brands,quantity,image_front_url";

const $ = id => document.getElementById(id);
const db = new Promise((res, rej) => {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => r.result.createObjectStore("products", { keyPath: "ean" });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(mode, fn) {
  const d = await db;
  return new Promise((res, rej) => {
    const t = d.transaction("products", mode);
    const out = fn(t.objectStore("products"));
    t.oncomplete = () => res(out?.result);
    t.onerror = () => rej(t.error);
  });
}
const dbGet = ean => tx("readonly", s => s.get(ean));
const dbPut = rec => tx("readwrite", s => s.put(rec));
const dbDel = ean => tx("readwrite", s => s.delete(ean));
const dbAll = () => tx("readonly", s => s.getAll());

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
    return { name: m.name, brand: m.brand, quantity: m.quantity };
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

function show(rec, state) {
  $("result").hidden = state === "unknown" || state === "offline";
  $("unknown").hidden = state !== "unknown";
  if (state === "unknown") {
    $("u-ean").textContent = rec.ean + (Lib.isBelgianPrefix(rec.ean) ? " · BE" : "");
    $("u-name").value = "";
    $("u-brand").value = "";
    $("u-name").focus();
    return;
  }
  if (state === "offline") { $("status").textContent = "No network — can't look up " + rec.ean + ". Try again."; return; }
  $("r-ean").textContent = rec.ean + (Lib.isBelgianPrefix(rec.ean) ? " · BE" : "");
  $("r-name").textContent = rec.name;
  $("r-meta").textContent = [rec.brand, rec.quantity].filter(Boolean).join(" · ");
  $("r-source").textContent = rec.source === "manual" ? "entered by you" : "Open Food Facts";
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
    $("status").textContent = state === "off" ? "Found online ✔" : state === "local" ? "Found in local DB ✔" : "";
    if (state !== "offline" && state !== "unknown") navigator.vibrate?.(60);
    show(rec, state);
    if (state === "unknown") pendingEan = ean;
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
  const now = Date.now();
  const rec = { ean: pendingEan, name, brand: $("u-brand").value.trim(), quantity: "", source: "manual", scans: 1, firstSeen: now, lastSeen: now };
  await dbPut(rec);
  pendingEan = null;
  $("status").textContent = "Saved ✔";
  show(rec, "local");
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

// ---- History / export ----
function switchTab(name) {
  $("view-scan").hidden = name !== "scan";
  $("view-history").hidden = name !== "history";
  $("tab-scan").classList.toggle("active", name === "scan");
  $("tab-history").classList.toggle("active", name === "history");
  if (name === "history") { stopScan(); renderHistory(); }
}
$("tab-scan").onclick = () => switchTab("scan");
$("tab-history").onclick = () => switchTab("history");

async function renderHistory() {
  const q = $("filter").value.trim().toLowerCase();
  const all = (await dbAll()).sort((a, b) => b.lastSeen - a.lastSeen)
    .filter(r => !q || (r.name + " " + r.brand + " " + r.ean).toLowerCase().includes(q));
  const ul = $("list");
  ul.replaceChildren(...all.map(r => {
    const li = document.createElement("li");
    const del = document.createElement("button");
    del.className = "del"; del.textContent = "✕";
    del.onclick = async () => { if (confirm("Delete " + r.name + "?")) { await dbDel(r.ean); renderHistory(); } };
    const b = document.createElement("b"); b.textContent = r.name;
    const s = document.createElement("small");
    s.textContent = [r.ean, r.brand, r.quantity, r.source === "manual" ? "manual" : "OFF", "×" + r.scans].filter(Boolean).join(" · ");
    li.append(del, b, s);
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
$("btn-backup").onclick = async () => download("be-food-scan-backup.json", "application/json", JSON.stringify(await dbAll(), null, 1));
$("file-restore").onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const rows = JSON.parse(await f.text());
    if (!Array.isArray(rows)) throw new Error("not a backup file");
    for (const r of rows) if (r.ean && r.name) await dbPut(r);
    alert("Restored " + rows.length + " products");
    renderHistory();
  } catch (err) { alert("Restore failed: " + err.message); }
  e.target.value = "";
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
