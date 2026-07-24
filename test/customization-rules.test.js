const assert = require("assert");
const { validateConfiguredItem } = require("../src/helpers/customizationRules");

const product = { id: 10, price: 8 };
const steps = [{
  product_step_id: 20,
  name: "Boisson",
  minimum_choices: 1,
  maximum_choices: 1,
  available: true,
  choices: [
    { product_step_choice_id: 30, available: true, extra_price: 0.5, choice_type: "linked_product", choice_name: "Cola", linked_product_id: 2 },
    { product_step_choice_id: 31, available: false, extra_price: 0, choice_type: "linked_product", choice_name: "Eau", linked_product_id: 3 },
  ],
}];

const configuredItem = validateConfiguredItem({
  product,
  steps,
  selectedChoiceIds: [30],
});

assert.strictEqual(configuredItem.unitPrice, 8.5);
assert.deepStrictEqual(configuredItem.selectedChoices, [{
  product_step_choice_id: 30,
  step_id: 20,
  step_name: "Boisson",
  choice_type: "linked_product",
  choice_name: "Cola",
  extra_price: 0.5,
  linked_product_id: 2,
}]);

assert.throws(
  () => validateConfiguredItem({ product, steps, selectedChoiceIds: [] }),
  (error) => error.code === "CUSTOMIZATION_MIN_NOT_MET" && error.product_step_id === 20,
);
assert.throws(
  () => validateConfiguredItem({ product, steps, selectedChoiceIds: [31] }),
  (error) => error.code === "CUSTOMIZATION_STEP_UNAVAILABLE" && error.product_step_id === 20 && error.product_step_choice_id === 31,
);
assert.throws(
  () => validateConfiguredItem({ product, steps, selectedChoiceIds: [30, 30] }),
  (error) => error.code === "CUSTOMIZATION_CHOICE_NOT_ALLOWED" && error.product_step_choice_id === 30,
);
assert.throws(
  () => validateConfiguredItem({ product, steps, selectedChoiceIds: [99] }),
  (error) => error.code === "CUSTOMIZATION_CHOICE_NOT_ALLOWED" && error.product_step_choice_id === 99,
);
assert.throws(
  () => validateConfiguredItem({
    product,
    steps: [{ ...steps[0], available: false }],
    selectedChoiceIds: [30],
  }),
  (error) => error.code === "CUSTOMIZATION_STEP_UNAVAILABLE" && error.product_step_id === 20,
);
assert.throws(
  () => validateConfiguredItem({
    product,
    steps: [{ ...steps[0], active: 0 }],
    selectedChoiceIds: [30],
  }),
  (error) => error.code === "CUSTOMIZATION_STEP_UNAVAILABLE" && error.product_step_id === 20,
);
assert.throws(
  () => validateConfiguredItem({
    product,
    steps: [{
      ...steps[0],
      choices: [{ ...steps[0].choices[0], available: 0 }],
    }],
    selectedChoiceIds: [30],
  }),
  (error) => error.code === "CUSTOMIZATION_STEP_UNAVAILABLE" && error.product_step_choice_id === 30,
);
assert.throws(
  () => validateConfiguredItem({
    product,
    steps: [{ ...steps[0], maximum_choices: 0 }],
    selectedChoiceIds: [30],
  }),
  (error) => error.code === "CUSTOMIZATION_MAX_EXCEEDED" && error.product_step_id === 20,
);
assert.strictEqual(validateConfiguredItem({
  product: { id: 10, price: "8.005" },
  steps: [{
    ...steps[0],
    minimum_choices: 0,
    maximum_choices: 2,
    choices: [{ ...steps[0].choices[0], extra_price: "0.005" }],
  }],
  selectedChoiceIds: [30],
}).unitPrice, 8.02);

console.log("customization rule tests passed");
