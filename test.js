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

// inventory model
const ev = (dev, seq, type, f, t) => L.makeEvent(dev, seq, type, f, t);
const E = [ev("a", 1, "stock", { item: "111", delta: 2 }, 1), ev("b", 1, "stock", { item: "111", delta: -5 }, 2),
  ev("a", 2, "name", { item: "111", name: "Old", category: "drinks" }, 3), ev("b", 2, "name", { item: "111", name: "New" }, 3),
  { id: "z", item: "111", type: "stock", delta: 1.5 }, { type: "stock", item: "1", delta: 1 }];
const mAB = L.mergeEvents(E.slice(0, 2), E.slice(2)), mBA = L.mergeEvents(E.slice(2), E.slice(0, 2));
assert.deepStrictEqual(mAB, mBA);
assert.deepStrictEqual(L.mergeEvents(mAB, mAB), mAB);
assert.strictEqual(mAB.length, 5);
const st = L.reduceEvents(mAB);
assert.deepStrictEqual(st, L.reduceEvents([...mAB].reverse().concat(mAB)));
assert.strictEqual(st.stock["111"], -3);
assert.strictEqual(st.names["111"].name, "New"); // same t, dev b > a
assert.strictEqual(L.resolveItem("111", st).count, 0);
const st2 = L.reduceEvents([...E, ev("a", 3, "name", { item: "111", name: "" }, 9)]);
assert.ok(!("111" in st2.names));
assert.deepStrictEqual(L.reduceEvents([ev("a", 4, "name", { item: "111", name: "" }, 1), ev("a", 5, "name", { item: "111", name: "X" }, 2)]).names["111"].name, "X");
const prod = { name: "Cola", category: "drinks" };
const st3 = L.reduceEvents([ev("a", 1, "stock", { item: "111", delta: 3 }, 1)]);
assert.deepStrictEqual(L.resolveItem("111", st3, prod), { item: "111", ean: "111", name: "Cola", category: "drinks", isOverride: false, count: 3 });
assert.strictEqual(L.resolveItem("111", st3).name, "111");
assert.strictEqual(L.resolveItem("111", st3).category, "other");
const st4 = L.reduceEvents([ev("a", 1, "stock", { item: "111", delta: 3 }, 1), ev("a", 2, "name", { item: "111", name: "Mine", category: "dairy-eggs" }, 2),
  ev("a", 3, "stock", { item: L.itemIdForName("Crème Brûlée!"), delta: 1 }, 3), ev("a", 4, "name", { item: "x:creme-brulee", name: "Crème brûlée", category: "snacks-sweets" }, 4)]);
const r4 = L.resolveItem("111", st4, prod);
assert.deepStrictEqual([r4.name, r4.category, r4.isOverride], ["Mine", "dairy-eggs", true]);
assert.strictEqual(L.itemIdForName("Crème Brûlée!"), "x:creme-brulee");
assert.strictEqual(L.itemIdForName("???"), "x:item");
const rx = L.resolveItem("x:creme-brulee", st4);
assert.ok(!("ean" in rx) && rx.name === "Crème brûlée");
const rows = L.inventoryRows(st4, [{ ean: "111", name: "Cola", category: "drinks" }]);
assert.deepStrictEqual(rows.map(r => r.item), ["111", "x:creme-brulee"]);
assert.strictEqual(L.inventoryRows(L.reduceEvents([ev("a", 1, "stock", { item: "9", delta: -1 }, 1)]), {}, { includeZero: true }).length, 1);
const txt = L.menuText(rows);
assert.ok(txt.includes("- Mine ×3") && txt.includes("- Crème brûlée ×1") && /ingrediënten/.test(txt));
assert.ok(/ingredients/.test(L.menuText(rows, "en")) && !L.menuText([{ ...rows[0], count: 0 }]).includes("- "));
const js = L.inventoryJson(rows);
assert.deepStrictEqual([js.items.length, js.items[0].ean, js.items[1].ean, typeof js.generatedAt], [2, "111", null, "string"]);
assert.strictEqual(L.coarseCategory(["en:beverages", "en:dairies"]), "drinks");
assert.strictEqual(L.coarseCategory(["en:frozen-foods", "en:meats"]), "frozen");
assert.strictEqual(L.coarseCategory(["en:cheeses"]), "dairy-eggs");
assert.strictEqual(L.coarseCategory(["en:xyz"]), "other");
assert.strictEqual(L.coarseCategory(), "other");
assert.strictEqual(L.mapOffProduct({ status: 1, product: { categories_tags: ["en:breads"] } }).category, "bakery");
console.log("ok");
