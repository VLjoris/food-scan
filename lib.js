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

  csvEscape(v) {
    v = String(v ?? "");
    return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  },
};
if (typeof module !== "undefined") module.exports = Lib;
