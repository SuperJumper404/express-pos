const assert = require("assert");
const {
  validateStockItemPayload,
  validateReplenishmentPayload,
  validateInventoryPayload,
  mapStockItemResponse,
} = require("../src/controllers/c_stockInventory");

assert.deepStrictEqual(validateStockItemPayload({
  name: "Fromage",
  unit: "paquet",
  current_stock: 2,
  minimum_stock: 6,
  target_stock: 20,
  category_label: "Frais",
}), {
  name: "Fromage",
  unit: "paquet",
  current_stock: 2,
  minimum_stock: 6,
  target_stock: 20,
  category_label: "Frais",
  reference: null,
  default_supplier: null,
  note: null,
});

assert.throws(() => validateStockItemPayload({
  name: "Fromage",
  unit: "paquet",
  current_stock: 2,
  minimum_stock: 6,
  target_stock: 5,
}), /Le stock cible doit etre superieur ou egal au seuil minimum/);

assert.deepStrictEqual(validateReplenishmentPayload({
  quantity: "4",
  supplier: "Metro",
  unit_price: "8",
}), {
  quantity: 4,
  supplier: "Metro",
  unit_price: 8,
  total_price: 32,
  remark: null,
});

assert.deepStrictEqual(validateInventoryPayload({ quantity: "0" }), {
  quantity: 0,
  remark: null,
});

assert.strictEqual(mapStockItemResponse({
  current_stock: 2,
  minimum_stock: 6,
  target_stock: 20,
}).status, "red");

console.log("stock inventory controller tests passed");
