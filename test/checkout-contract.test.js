const assert = require("assert");
const {
  createCustomizationChoice,
  createCustomizationStep,
  deleteCustomizationChoice,
  deleteCustomizationStep,
  getCustomizationStep,
  getProductCustomizationState,
  groupResolvedConfigurationRows,
  getResolvedProductConfigurations,
  listCustomizationSteps,
  replaceProductConfiguration,
  updateCustomizationChoice,
  updateCustomizationStep,
} = require("../src/modules/m_customizations");

const grouped = groupResolvedConfigurationRows([{
  product_id: 1,
  product_step_id: 10,
  step_id: 20,
  step_name: "Boissons",
  minimum_choices: 1,
  maximum_choices: 1,
  step_position: 2,
  product_step_choice_id: 30,
  step_choice_id: 40,
  choice_type: "simple",
  simple_name: "Eau",
  simple_image: "eau.webp",
  linked_name: null,
  linked_image: null,
  linked_stock: null,
  linked_archived: null,
  extra_price: "0.50",
  choice_position: 1,
  choice_active: 1,
}]);

assert.strictEqual(grouped.get(1)[0].choices[0].name, "Eau");
assert.strictEqual(grouped.get(1)[0].choices[0].available, true);

const unavailable = groupResolvedConfigurationRows([
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 31,
    step_choice_id: 41,
    choice_type: "linked_product",
    linked_product_id: 3,
    linked_name: "Frites",
    linked_image: "frites.webp",
    linked_stock: "5",
    linked_archived: "0",
    linked_is_hidden: 1,
    extra_price: "1.00",
    choice_position: 2,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 32,
    step_choice_id: 42,
    choice_type: "linked_product",
    linked_product_id: 4,
    linked_name: "Salade",
    linked_image: "salade.webp",
    linked_stock: 0,
    linked_archived: 0,
    linked_is_hidden: 0,
    extra_price: "0.00",
    choice_position: 1,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 33,
    step_choice_id: 43,
    choice_type: "linked_product",
    linked_product_id: 5,
    linked_name: "Potatoes",
    linked_image: "potatoes.webp",
    linked_stock: 5,
    linked_archived: 1,
    linked_is_hidden: 0,
    extra_price: "0.00",
    choice_position: 3,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 34,
    step_choice_id: 44,
    choice_type: "simple",
    simple_name: "Sans accompagnement",
    simple_image: null,
    extra_price: "0.00",
    choice_position: 4,
    product_step_choice_active: 0,
    choice_active: 1,
  },
]);
const unavailableSteps = unavailable.get(2);
assert.strictEqual(unavailableSteps[0].choices[1].name, "Frites");
assert.strictEqual(unavailableSteps[0].choices[1].available, true);
assert.strictEqual(
  unavailableSteps[0].choices.find((choice) => choice.product_step_choice_id === 33).available,
  false,
);
assert.strictEqual(
  unavailableSteps[0].choices.find((choice) => choice.product_step_choice_id === 34).available,
  false,
);
assert.strictEqual(unavailableSteps[0].available_choice_count, 1);
assert.strictEqual(unavailableSteps[0].available, false);
assert.strictEqual(unavailableSteps.customization_available, false);
assert.strictEqual(unavailableSteps.blocking_product_step_id, 11);
assert.deepStrictEqual(unavailableSteps.unavailable_reason, {
  code: "INSUFFICIENT_AVAILABLE_CHOICES",
  available_choice_count: 1,
  minimum_choices: 2,
});
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(getProductCustomizationState(unavailableSteps))),
  {
    customization_available: false,
    product_step_id: 11,
    reason: {
      code: "INSUFFICIENT_AVAILABLE_CHOICES",
      available_choice_count: 1,
      minimum_choices: 2,
    },
  },
);

const runRepositoryReadContracts = async () => {
  const resolvedCalls = [];
  const resolvedConnection = {
    query: async (sql, params) => {
      resolvedCalls.push({ sql, params });
      return [[{
        product_id: 8,
        product_step_id: 80,
        step_id: 81,
        step_name: "Sauces",
        minimum_choices: 0,
        maximum_choices: 2,
        step_position: 1,
        product_step_choice_id: null,
      }]];
    },
  };
  const resolved = await getResolvedProductConfigurations({
    shopId: 7,
    productIds: ["8", "9", 8],
    connection: resolvedConnection,
  });
  assert.strictEqual(resolvedCalls.length, 1);
  assert.match(resolvedCalls[0].sql, /p\.id IN \(\?\)/);
  assert.match(resolvedCalls[0].sql, /LEFT JOIN customization_step_choices/);
  assert.match(resolvedCalls[0].sql, /LEFT JOIN products linked_product/);
  assert.deepStrictEqual(resolvedCalls[0].params, [7, ["8", "9"]]);
  assert.strictEqual(resolved.get("8")[0].name, "Sauces");
  assert.ok(!resolved.has(8));
  assert.deepStrictEqual(resolved.get("9"), []);
  assert.strictEqual(resolved.get("9").customization_available, true);

  const listCalls = [];
  const listed = await listCustomizationSteps(7, {
    query: async (sql, params) => {
      listCalls.push({ sql, params });
      return [[
        {
          step_id: 5,
          step_name: "Boissons",
          step_description: "Choisissez",
          step_active: 1,
          step_created: "created",
          step_updated: null,
          choice_id: 51,
          choice_type: "simple",
          simple_name: "Eau",
          simple_image: "eau.webp",
          linked_product_id: null,
          default_position: 2,
          choice_active: 1,
        },
      ]];
    },
  });
  assert.strictEqual(listCalls.length, 1);
  assert.deepStrictEqual(listCalls[0].params, [7]);
  assert.strictEqual(listed[0].choices[0].name, "Eau");

  const replacementCalls = [];
  const replacementConnection = {
    query: async (sql, params) => {
      replacementCalls.push({ sql, params });
      if (/SELECT p\.id[\s\S]*FROM products p/.test(sql)) return [[{ id: 100 }]];
      if (/SELECT step\.id[\s\S]*FROM customization_steps step/.test(sql)) {
        return [[{ id: 20 }]];
      }
      if (/SELECT[\s\S]*choice\.id[\s\S]*FROM customization_step_choices choice/.test(sql)) {
        return [[{
          id: 40,
          step_id: 20,
          choice_type: "simple",
          linked_product_id: null,
          linked_shop_id: null,
        }]];
      }
      if (/INSERT INTO product_customization_steps/.test(sql)) {
        return [{ insertId: 200 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
  await replaceProductConfiguration({
    shopId: 7,
    productId: 100,
    steps: [{
      step_id: 20,
      position: 1,
      minimum_choices: 1,
      maximum_choices: 1,
      active: true,
      choices: [{
        step_choice_id: 40,
        extra_price: "0.50",
        position: 1,
        active: true,
      }],
    }],
    connection: replacementConnection,
  });
  const firstDelete = replacementCalls.findIndex(({ sql }) => /DELETE FROM/.test(sql));
  assert.ok(firstDelete >= 3, "all ownership reads happen before replacement");
  assert.match(replacementCalls[firstDelete].sql, /product_customization_step_choices/);
  assert.ok(replacementCalls.some(({ sql, params }) => (
    /INSERT INTO product_customization_step_choices/.test(sql)
      && params[1] === 40
  )));

  const baseStep = {
    step_id: 20,
    minimum_choices: 1,
    maximum_choices: 1,
    choices: [{ step_choice_id: 40 }],
  };
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep, { ...baseStep, choices: [] }],
      connection: replacementConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_STEP_DUPLICATE",
  );
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [{ ...baseStep, choices: [{ step_choice_id: 40 }, { step_choice_id: 40 }] }],
      connection: replacementConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_CHOICE_DUPLICATE",
  );
  for (const invalidLimits of [
    { minimum_choices: -1, maximum_choices: 1 },
    { minimum_choices: 0, maximum_choices: 0 },
    { minimum_choices: 2, maximum_choices: 1 },
  ]) {
    await assert.rejects(
      () => replaceProductConfiguration({
        shopId: 7,
        productId: 100,
        steps: [{ ...baseStep, ...invalidLimits }],
        connection: replacementConnection,
      }),
      (error) => error.code === "CUSTOMIZATION_LIMITS_INVALID",
    );
  }

  const ownershipConnection = ({ stepRows, choiceRows }) => {
    const calls = [];
    return {
      calls,
      query: async (sql) => {
        calls.push(sql);
        if (/FROM products p/.test(sql)) return [[{ id: 100 }]];
        if (/FROM customization_steps step/.test(sql)) return [stepRows];
        if (/FROM customization_step_choices choice/.test(sql)) return [choiceRows];
        throw new Error("replacement mutated before full validation");
      },
    };
  };
  const foreignStepConnection = ownershipConnection({ stepRows: [], choiceRows: [] });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: foreignStepConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_STEP_NOT_OWNED",
  );
  assert.ok(!foreignStepConnection.calls.some((sql) => /DELETE FROM/.test(sql)));

  const wrongStepConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 99,
      choice_type: "simple",
      linked_product_id: null,
      linked_shop_id: null,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: wrongStepConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_CHOICE_STEP_MISMATCH",
  );

  const selfLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 100,
      linked_shop_id: 7,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: selfLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_PARENT_SELF_LINK",
  );
  assert.ok(!selfLinkConnection.calls.some((sql) => /DELETE FROM/.test(sql)));

  const stringSelfLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 100,
      linked_shop_id: 7,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: "7",
      productId: "100",
      steps: [{
        ...baseStep,
        step_id: "20",
        choices: [{ step_choice_id: "40" }],
      }],
      connection: stringSelfLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_PARENT_SELF_LINK",
  );

  const foreignLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 200,
      linked_shop_id: 8,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: foreignLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_LINKED_PRODUCT_NOT_OWNED",
  );

  const crudCalls = [];
  const crudConnection = {
    query: async (sql, params) => {
      crudCalls.push({ sql, params });
      if (/SELECT[\s\S]*FROM customization_steps step[\s\S]*step\.id = \?/.test(sql)) {
        return [[{
          step_id: 20,
          step_name: "Boissons",
          step_description: null,
          step_active: 1,
          choice_id: null,
        }]];
      }
      if (/SELECT[\s\S]*FROM customization_step_choices choice/.test(sql)) {
        return [[{
          id: 40,
          step_id: 20,
          choice_type: "simple",
          name: "Eau",
          image: "old.webp",
          linked_product_id: null,
          default_position: 1,
          active: 1,
        }]];
      }
      if (/SELECT step\.id FROM customization_steps step/.test(sql)) return [[{ id: 20 }]];
      if (/INSERT INTO customization_steps/.test(sql)) return [{ insertId: 20 }];
      if (/INSERT INTO customization_step_choices/.test(sql)) return [{ insertId: 40 }];
      return [{ affectedRows: 1 }];
    },
  };
  assert.strictEqual((await getCustomizationStep({
    shopId: 7,
    stepId: 20,
    connection: crudConnection,
  })).name, "Boissons");
  assert.strictEqual((await createCustomizationStep({
    shopId: 7,
    data: { name: "Desserts", description: "Optionnel", active: "false" },
    connection: crudConnection,
  })).insertId, 20);
  await updateCustomizationStep({
    shopId: 7,
    stepId: 20,
    data: { name: "Boissons froides", active: "false" },
    connection: crudConnection,
  });
  await deleteCustomizationStep({ shopId: 7, stepId: 20, connection: crudConnection });
  assert.strictEqual((await createCustomizationChoice({
    shopId: 7,
    stepId: 20,
    data: {
      choice_type: "simple",
      name: "Eau",
      image: "eau.webp",
      default_position: 1,
      active: "false",
    },
    connection: crudConnection,
  })).insertId, 40);
  await updateCustomizationChoice({
    shopId: 7,
    choiceId: 40,
    data: { name: "Eau plate", image: "eau-plate.webp", active: "false" },
    connection: crudConnection,
  });
  await deleteCustomizationChoice({ shopId: 7, choiceId: 40, connection: crudConnection });
  assert.ok(crudCalls.every(({ sql }) => !/\$\{|shopId|stepId|choiceId/.test(sql)));
  assert.ok(crudCalls.some(({ sql, params }) => (
    /UPDATE customization_steps/.test(sql) && params.includes(7)
  )));
  assert.ok(crudCalls.some(({ sql, params }) => (
    /UPDATE customization_step_choices choice/.test(sql) && params.includes(7)
  )));
  assert.strictEqual(
    crudCalls.find(({ sql }) => /INSERT INTO customization_steps/.test(sql)).params[3],
    0,
  );
  assert.strictEqual(
    crudCalls.find(({ sql }) => /INSERT INTO customization_step_choices/.test(sql)).params[6],
    0,
  );
  assert.ok(require("../package.json").scripts.test.includes("checkout-contract.test.js"));
};

runRepositoryReadContracts()
  .then(() => console.log("customization catalog contracts passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
