const assert = require("assert");
const { buildStockRequirements } = require("../src/helpers/stockRequirements");

const requirements = buildStockRequirements([{
  product: { id: 1, track_stock: 1 },
  quantity: 2,
  selectedChoices: [{ choice_type: "linked_product", linked_product_id: 2, linked_product_track_stock: 1 }],
}]);
assert.deepStrictEqual([...requirements.entries()], [[1, 2], [2, 2]]);

const unconfiguredRequirements = buildStockRequirements([{
  product: { id: 9 },
  quantity: 2,
  selectedChoices: [],
}]);
assert.deepStrictEqual([...unconfiguredRequirements.entries()], []);

const aggregatedRequirements = buildStockRequirements([{
  product: { id: 1, track_stock: 1 },
  quantity: 2,
  selectedChoices: [
    { choice_type: "linked_product", linked_product_id: 2, linked_product_track_stock: 1 },
    { choice_type: "linked_product", linked_product_id: 2, linked_product_track_stock: 1 },
  ],
}]);
assert.deepStrictEqual([...aggregatedRequirements.entries()], [[1, 2], [2, 4]]);

const untrackedRequirements = buildStockRequirements([{
  product: { id: 1, track_stock: 0 },
  quantity: 2,
  selectedChoices: [{ choice_type: "linked_product", linked_product_id: 2, linked_product_track_stock: 0 }],
}]);
assert.deepStrictEqual([...untrackedRequirements.entries()], []);

const mixedRequirements = buildStockRequirements([{
  product: { id: 1, track_stock: 1 },
  quantity: 2,
  selectedChoices: [
    { choice_type: "linked_product", linked_product_id: 2, linked_product_track_stock: 0 },
    { choice_type: "linked_product", linked_product_id: 3, linked_product_track_stock: 1 },
  ],
}]);
assert.deepStrictEqual([...mixedRequirements.entries()], [[1, 2], [3, 2]]);

console.log("stock requirements tests passed");
