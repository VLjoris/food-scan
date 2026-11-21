// Pure helpers (no DOM) so they can be unit-tested with node.
const Lib = {
  SCAN_FORMATS: ["EAN_13", "EAN_8", "UPC_A", "UPC_E"],

  // 8-digit UPC-E (number system 0/1) -> 12-digit UPC-A, or null. Check digit is validated by normalizeEan.
  expandUpcE(d) {
    if (!/^[01]\d{7}$/.test(d)) return null;
    const [ns, a, b, c, e, f, g] = d.slice(0, 7);
    const chk = d[7];
    const body = { 0: a + b + g + "0000" + c + e + f, 1: a + b + g + "0000" + c + e + f, 2: a + b + g + "0000" + c + e + f,
      3: a + b + c + "00000" + e + f, 4: a + b + c + e + "00000" + f }[g] ?? a + b + c + e + f + "0000" + g;
    return ns + body + chk;
  },

  isVariableWeight(ean) {
    return /^2[0-9]\d{11}$/.test(String(ean));
  },

  mapOffProduct(j) {
    const p = j && j.status === 1 && j.product;
    if (!p) return null;
    const t = v => (typeof v === "string" ? v.trim() : "");
    const name = Lib.pickName(p);
    const brand = t((p.brands || "").split(",")[0]);
    const quantity = t(p.quantity);
    const names = { nl: t(p.product_name_nl), fr: t(p.product_name_fr), en: t(p.product_name_en) };
    return {
      name, brand, quantity, names,
      category: Lib.coarseCategory(p.categories_tags),
      hasImage: !!p.image_front_url,
      completeness: { name: !!name, nameNl: !!names.nl, nameFr: !!names.fr, brand: !!brand, quantity: !!quantity },
    };
  },

  // Valid EAN-8 / UPC-A (12) / EAN-13 / GTIN-14 checksum. Returns normalized EAN-13 (or EAN-8) or null.
  normalizeEan(raw, format) {
    let d = String(raw || "").replace(/\D/g, "");
    if (format === "UPC_E") {
      d = Lib.expandUpcE(d);
      if (!d) return null;
    }
    if (![8, 12, 13, 14].includes(d.length)) return null;
    const digits = d.split("").map(Number);
    const check = digits.pop();
    let sum = 0;
    for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += digits[i] * w;
    if ((10 - (sum % 10)) % 10 !== check) return null;
    if (d.length === 12) return "0" + d;
    if (d.length === 14 && d[0] === "0") return d.slice(1);
    return d;
  },

  // GS1 prefixes 540-549 = Belgium/Luxembourg (informational only; never blocks a lookup).
  isBelgianPrefix(ean) {
    return ean.length === 13 && /^54[0-9]/.test(ean);
  },

  // Canonical name first; fall back to NL/FR/EN variants, then generic name.
  pickName(p, langs = ["nl", "fr", "en"]) {
    if (!p) return "";
    if (p.product_name?.trim()) return p.product_name.trim();
    for (const l of langs) if (p["product_name_" + l]?.trim()) return p["product_name_" + l].trim();
    return (p.generic_name || "").trim();
  },

  CATEGORIES: [
    { key: "fruit-veg", label: "Fruit & vegetables" },
    { key: "dairy-eggs", label: "Dairy & eggs" },
    { key: "meat-fish", label: "Meat & fish" },
    { key: "bakery", label: "Bread & bakery" },
    { key: "pantry", label: "Pantry" },
    { key: "frozen", label: "Frozen" },
    { key: "drinks", label: "Drinks" },
    { key: "snacks-sweets", label: "Snacks & sweets" },
    { key: "other", label: "Other" },
  ],

  // Ordered rules: the first match wins (e.g. frozen before the food type).
  coarseCategory(tags) {
    const s = (Array.isArray(tags) ? tags : []).map(x => String(x).toLowerCase().replace(/^[a-z]{2}:/, "")).join(" ");
    if (!s) return "other";
    const rules = [
      ["frozen", /frozen|surgel|diepvries/],
      ["drinks", /beverage|drink|water|juice|soda|beer|wine|coffee|\btea\b|lemonade/],
      ["dairy-eggs", /dairy|milk|cheese|yogurt|yoghurt|butter|cream|\begg/],
      ["meat-fish", /meat|fish|seafood|poultry|chicken|beef|pork|sausage|ham\b|charcuterie/],
      ["fruit-veg", /fruit|vegetable|legume|salad|potato/],
      ["bakery", /bread|bakery|baguette|pastr|viennoiserie|croissant/],
      ["snacks-sweets", /snack|sweet|chocolate|candy|candies|biscuit|cookie|cake|confection|chips|crisps|dessert/],
      ["pantry", /pasta|rice|cereal|flour|sauce|oil|canned|spice|condiment|sugar|grain|noodle|soup|spread|jam|honey|plant-based|groceries/],
    ];
    for (const [k, re] of rules) if (re.test(s)) return k;
    return "other";
  },

  makeEvent(dev, seq, type, fields, t = Date.now()) {
    return { id: `${dev}:${seq}`, t, dev, type, ...fields };
  },

  _cmpEv(a, b) {
    return (a.t - b.t) || (a.dev < b.dev ? -1 : a.dev > b.dev ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  },

  mergeEvents(a, b) {
    const m = new Map();
    for (const e of [...(a || []), ...(b || [])]) if (e && e.id != null && !m.has(e.id)) m.set(e.id, e);
    return [...m.values()].sort(Lib._cmpEv);
  },

  reduceEvents(events) {
    const stock = {}, names = {};
    const seen = new Set();
    const valid = [];
    for (const e of events || []) {
      if (!e || !e.id || !e.item || !e.type || seen.has(e.id)) continue;
      if (e.type === "stock" && !Number.isInteger(e.delta)) continue;
      if (e.type === "name" && typeof e.name !== "string") continue;
      seen.add(e.id);
      valid.push(e);
    }
    valid.sort(Lib._cmpEv);
    for (const e of valid) {
      if (e.type === "stock") stock[e.item] = (stock[e.item] || 0) + e.delta;
      else if (e.type === "name") {
        if (e.name === "") delete names[e.item];
        else names[e.item] = { name: e.name, category: e.category || "", t: e.t, dev: e.dev };
      }
    }
    return { stock, names };
  },

  resolveItem(item, state, product) {
    const ov = state?.names?.[item];
    const isX = item.startsWith("x:");
    const sum = state?.stock?.[item] || 0;
    const name = ov?.name || product?.name || (isX ? item.slice(2) : item);
    const category = ov?.category || product?.category || "other";
    const r = { item, name, category, isOverride: !!ov, count: Math.max(0, sum) };
    if (!isX) r.ean = item;
    return r;
  },

  inventoryRows(state, products, { includeZero = false } = {}) {
    const byEan = Array.isArray(products) ? Object.fromEntries(products.filter(p => p && p.ean).map(p => [p.ean, p])) : products || {};
    const items = new Set([...Object.keys(state?.stock || {}), ...Object.keys(state?.names || {})]);
    const order = k => { const i = Lib.CATEGORIES.findIndex(c => c.key === k); return i < 0 ? Lib.CATEGORIES.length : i; };
    return [...items].map(i => Lib.resolveItem(i, state, byEan[i])).filter(r => includeZero || r.count > 0)
      .sort((a, b) => order(a.category) - order(b.category) || a.name.localeCompare(b.name));
  },

  menuText(rows, lang = "nl") {
    const rs = (rows || []).filter(r => r.count > 0);
    const lines = [];
    for (const c of Lib.CATEGORIES) {
      const g = rs.filter(r => (Lib.CATEGORIES.some(x => x.key === r.category) ? r.category : "other") === c.key);
      if (!g.length) continue;
      lines.push(c.label + ":", ...g.map(r => `- ${r.name} ×${r.count}`), "");
    }
    const prompt = lang === "en"
      ? "Suggest a few menus or recipes I can make using only these ingredients plus basic pantry staples (salt, pepper, oil, flour, sugar, spices). Prefer using up what I have most of."
      : "Stel een paar menu's of recepten voor die ik kan maken met alleen deze ingrediënten plus basis keukenvoorraad (zout, peper, olie, bloem, suiker, kruiden). Gebruik bij voorkeur op wat ik het meest heb.";
    return lines.join("\n") + prompt + "\n";
  },

  inventoryJson(rows) {
    return {
      generatedAt: new Date().toISOString(),
      items: (rows || []).filter(r => r.count > 0).map(r => ({
        item: r.item, ean: r.ean || null, name: r.name, category: r.category, count: r.count, isOverride: !!r.isOverride,
      })),
    };
  },

  itemIdForName(name) {
    const slug = String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return "x:" + (slug || "item");
  },

  csvEscape(v) {
    v = String(v ?? "");
    return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  },
};
if (typeof module !== "undefined") module.exports = Lib;
