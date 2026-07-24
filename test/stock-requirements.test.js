const assert = require("assert");
const { buildStockRequirements } = require("../src/helpers/stockRequirements");

const requirements = buildStockRequirements([{
  product: { id: 1 },
  quantity: 2,
  selectedChoices: [{ choice_type: "linked_product", linked_product_id: 2 }],
}]);
assert.deepStrictEqual([...requirements.entries()], [[1, 2], [2, 2]]);

const aggregatedRequirements = buildStockRequirements([{
  product: { id: 1 },
  quantity: 2,
  selectedChoices: [
    { choice_type: "linked_product", linked_product_id: 2 },
    { choice_type: "linked_product", linked_product_id: 2 },
  ],
}]);
assert.deepStrictEqual([...aggregatedRequirements.entries()], [[1, 2], [2, 4]]);

console.log("stock requirements tests passed");
