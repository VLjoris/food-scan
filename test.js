const assert = require("node:assert");
const L = require("./lib.js");

assert.strictEqual(L.normalizeEan("5449000000996"), "5449000000996");
assert.strictEqual(L.normalizeEan("4006381333931"), "4006381333931");
assert.strictEqual(L.normalizeEan("4006381333932"), null);           // bad checksum
assert.strictEqual(L.normalizeEan("036000291452"), "0036000291452"); // UPC-A -> EAN-13
assert.strictEqual(L.normalizeEan("96385074"), "96385074");          // EAN-8
assert.strictEqual(L.normalizeEan("123"), null);
assert.ok(L.isBelgianPrefix("5400141170011"));
assert.ok(!L.isBelgianPrefix("4006381333931"));
assert.strictEqual(L.pickName({ product_name_fr: " Chocolat " }), "Chocolat");
assert.strictEqual(L.pickName({ product_name: "Choco", product_name_fr: "Chocolat" }), "Choco");
assert.strictEqual(L.csvEscape('a"b,c'), '"a""b,c"');
// UPC-E 04252614: body 425261, last digit 1 -> 0 42100 00526; check: weights 3,1,3.. over 04210000526 = 46 -> (10-6)%10 = 4
assert.strictEqual(L.expandUpcE("04252614"), "042100005264");
assert.strictEqual(L.normalizeEan("04252614", "UPC_E"), "0042100005264");
assert.strictEqual(L.normalizeEan("04252615", "UPC_E"), null);       // bad check digit
assert.strictEqual(L.expandUpcE("01234565"), "012345000065");        // last digit 5 -> d1-d5 0000 d6
assert.strictEqual(L.normalizeEan("01234565", "UPC_E"), "0012345000065");
assert.strictEqual(L.normalizeEan("23456789", "UPC_E"), null);       // number system 2 invalid
assert.deepStrictEqual(L.SCAN_FORMATS, ["EAN_13", "EAN_8", "UPC_A", "UPC_E"]);
assert.ok(L.isVariableWeight("2012345678900") && !L.isVariableWeight("5449000000996") && !L.isVariableWeight("20123"));
assert.strictEqual(L.mapOffProduct({ status: 0 }), null);
assert.strictEqual(L.mapOffProduct({ status: 1 }), null);
const m = L.mapOffProduct({ status: 1, product: { product_name_fr: " Choc ", brands: "Cote d'Or, Mondelez", quantity: "100 g", image_front_url: "x" } });
assert.deepStrictEqual([m.name, m.brand, m.quantity, m.hasImage, m.names.fr, m.names.nl], ["Choc", "Cote d'Or", "100 g", true, "Choc", ""]);
assert.deepStrictEqual(m.completeness, { name: true, nameNl: false, nameFr: true, brand: true, quantity: true });
const e = L.mapOffProduct({ status: 1, product: {} });
assert.deepStrictEqual([e.name, e.brand, e.hasImage, e.completeness.name], ["", "", false, false]);
console.log("ok");
