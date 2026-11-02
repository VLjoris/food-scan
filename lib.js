// Pure helpers (no DOM) so they can be unit-tested with node.
const Lib = {
  // Valid EAN-8 / UPC-A (12) / EAN-13 / GTIN-14 checksum. Returns normalized EAN-13 (or EAN-8) or null.
  normalizeEan(raw) {
    const d = String(raw || "").replace(/\D/g, "");
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

  csvEscape(v) {
    v = String(v ?? "");
    return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  },
};
if (typeof module !== "undefined") module.exports = Lib;
