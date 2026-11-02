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
console.log("ok");
