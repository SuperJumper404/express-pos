const assert = require("assert");
const pool = require("../src/config/dbPool");
const {
  createCustomizationChoice,
  deleteCustomizationChoicePermanently,
  replaceProductConfiguration,
  updateCustomizationStep,
} = require("../src/modules/m_customizations");

const testStepPriceUpdate = async () => {
  const events = [];
  const productPriceWrites = [];
  const updateConnection = {
    async beginTransaction() { events.push("begin"); },
    async commit() { events.push("commit"); },
    async rollback() { events.push("rollback"); },
    release() { events.push("release"); },
    async query(sql, params) {
      if (/SELECT step\.id FROM customization_steps step/.test(sql)) {
        assert.match(sql, /FOR UPDATE/);
        assert.deepStrictEqual(params, [10, 7]);
        return [[{ id: 10 }]];
      }
      if (/SELECT[\s\S]*step\.id AS step_id/.test(sql)) {
        return [[{ step_id: 10, step_name: "Boissons", step_active: 1 }]];
      }
      if (/SELECT id FROM customization_step_choices/.test(sql)) {
        assert.match(sql, /WHERE step_id = \? AND id IN \(\?\)[\s\S]*FOR UPDATE/);
        assert.strictEqual(params[0], 10);
        return [params[1].filter((id) => [55, 56].includes(id)).map((id) => ({ id }))];
      }
      if (/UPDATE customization_steps/.test(sql)) return [{ affectedRows: 1 }];
      if (/UPDATE customization_step_choices/.test(sql)) {
        assert.match(sql, /SET default_extra_price = \?, updated = NOW\(\)\s+WHERE step_id = \? AND id = \?/);
        assert.deepStrictEqual(params, ["1.25", 10, 55]);
        return [{ affectedRows: 1 }];
      }
      if (/UPDATE product_customization_step_choices/.test(sql)) {
        assert.match(sql, /ON product_step\.id = product_choice\.product_customization_step_id/);
        assert.match(sql, /ON product\.id = product_step\.product_id/);
        assert.match(sql, /SET product_choice\.extra_price = \?\s+WHERE product_step\.step_id = \? AND product_choice\.step_choice_id = \?\s+AND product\.shopid = \?/);
        productPriceWrites.push(params);
        return [{ affectedRows: 2 }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const getConnection = pool.getConnection;
  pool.getConnection = async () => updateConnection;
  const change = (choicePrices) => updateCustomizationStep({
    shopId: 7,
    stepId: 10,
    data: { name: "Boissons fraîches", choice_prices: choicePrices },
  });
  try {
    await change([{ choice_id: 55, default_extra_price: "1.25" }]);
    assert.deepStrictEqual(productPriceWrites, [["1.25", 10, 55, 7]]);
    assert.deepStrictEqual(events.splice(0), ["begin", "commit", "release"]);
    await assert.rejects(
      change([
        { choice_id: 55, default_extra_price: "1.25" },
        { choice_id: 99, default_extra_price: "0.00" },
      ]),
      { code: "CUSTOMIZATION_CHOICE_STEP_MISMATCH" },
    );
    assert.deepStrictEqual(productPriceWrites, [["1.25", 10, 55, 7]]);
    assert.deepStrictEqual(events, ["begin", "rollback", "release"]);
  } finally {
    pool.getConnection = getConnection;
  }
};

const calls = [];
const testPreservesUneditedProductPrice = async () => {
  const inserts = [];
  await replaceProductConfiguration({
    shopId: 7,
    productId: 18,
    steps: [{
      step_id: 20,
      minimum_choices: 0,
      maximum_choices: 1,
      choices: [
        { step_choice_id: 55, extra_price: "1.00", keep_extra_price: true },
        { step_choice_id: 56, extra_price: "4.00" },
      ],
    }],
    connection: {
      async query(sql, params) {
        if (/SELECT p\.id/.test(sql)) return [[{ id: 18 }]];
        if (/SELECT step\.id/.test(sql)) return [[{ id: 20 }]];
        if (/SELECT[\s\S]*choice\.linked_product_id/.test(sql)) {
          return [[55, 56].map((id) => ({ id, step_id: 20, choice_type: "simple" }))];
        }
        if (/SELECT product_choice\.step_choice_id, product_choice\.extra_price/.test(sql)) {
          assert.deepStrictEqual(params, [18, [55]]);
          return [[{ step_choice_id: 55, extra_price: "2.00" }]];
        }
        if (/DELETE FROM/.test(sql)) return [{ affectedRows: 1 }];
        if (/INSERT INTO product_customization_steps/.test(sql)) return [{ insertId: 1 }];
        if (/INSERT INTO product_customization_step_choices/.test(sql)) {
          inserts.push(params);
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    },
  });
  assert.deepStrictEqual(inserts, [[1, 55, "2.00", 0, 1], [1, 56, "4.00", 1, 1]]);
};

const testAppendProductSteps = async () => {
  const inserts = [];
  await replaceProductConfiguration({
    shopId: 7,
    productId: 18,
    append: true,
    steps: [20, 30].map((step_id) => ({
      step_id, minimum_choices: 0, maximum_choices: 1, active: true, choices: [],
    })),
    connection: {
      async query(sql, params) {
        if (/SELECT p\.id/.test(sql)) return [[{ id: 18 }]];
        if (/SELECT step\.id/.test(sql)) return [[{ id: 20 }, { id: 30 }]];
        if (/SELECT step_id, position/.test(sql)) {
          assert.deepStrictEqual(params, [18]);
          return [[{ step_id: 10, position: 7 }]];
        }
        if (/INSERT INTO product_customization_steps/.test(sql)) {
          inserts.push(params);
          return [{ insertId: inserts.length }];
        }
        throw new Error(`Appending steps must preserve existing rows: ${sql}`);
      },
    },
  });
  assert.deepStrictEqual(inserts, [
    [18, 20, 8, 0, 1, 1],
    [18, 30, 9, 0, 1, 1],
  ]);
};

const connection = {
  async query(sql, params) {
    calls.push({ sql, params });
    if (/FROM customization_steps step/.test(sql)) return [[{ id: 10 }]];
    if (/INSERT INTO customization_step_choices/.test(sql)) return [{ insertId: 55 }];
    if (/FROM product_customization_steps product_step/.test(sql)) {
      return [[{ product_customization_step_id: 101 }, { product_customization_step_id: 202 }]];
    }
    if (/INSERT INTO product_customization_step_choices/.test(sql)) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected query: ${sql}`);
  },
};

(async () => {
  await testStepPriceUpdate();
  await testAppendProductSteps();
  await testPreservesUneditedProductPrice();
  const result = await createCustomizationChoice({
    shopId: 7,
    stepId: 10,
    data: {
      choice_type: "simple",
      name: "Citron",
      default_extra_price: "0.50",
      default_position: 3,
      active: true,
    },
    connection,
  });
  assert.strictEqual(result.insertId, 55);
  const productChoiceInserts = calls.filter(({ sql }) => /INSERT INTO product_customization_step_choices/.test(sql));
  assert.strictEqual(productChoiceInserts.length, 2);
  assert.deepStrictEqual(productChoiceInserts.map(({ params }) => params), [
    [101, 55, "0.50", 3, 1],
    [202, 55, "0.50", 3, 1],
  ]);

  const permanentDeleteCalls = [];
  const permanentDeleteConnection = {
    async query(sql, params) {
      permanentDeleteCalls.push({ sql, params });
      if (/FROM customization_step_choices choice/.test(sql)) {
        return [[{
          id: 55,
          step_id: 10,
          choice_type: "simple",
          name: "Citron",
          image: "citron.webp",
          linked_product_id: null,
          default_extra_price: "0.50",
          default_position: 3,
          active: 1,
        }]];
      }
      if (/SELECT choice\.image/.test(sql)) return [[{ image: "citron.webp" }]];
      if (/DELETE FROM product_customization_step_choices/.test(sql)) {
        return [{ affectedRows: 2 }];
      }
      if (/DELETE FROM customization_step_choices/.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected permanent delete query: ${sql}`);
    },
  };
  const permanentDeleteResult = await deleteCustomizationChoicePermanently({
    shopId: 7,
    choiceId: 55,
    connection: permanentDeleteConnection,
  });
  assert.strictEqual(permanentDeleteResult.affectedRows, 1);
  assert.deepStrictEqual(permanentDeleteResult.images, ["citron.webp"]);
  const permanentDeleteSql = permanentDeleteCalls.map(({ sql }) => sql);
  assert.ok(
    /DELETE FROM product_customization_step_choices/.test(permanentDeleteSql[2]),
    "permanent deletion must remove product-level choice links first",
  );
  assert.ok(
    /DELETE FROM customization_step_choices/.test(permanentDeleteSql[3]),
    "permanent deletion must remove the library choice after product links",
  );
  assert.deepStrictEqual(
    permanentDeleteCalls.slice(2).map(({ params }) => params),
    [[55], [55, 7]],
  );
  console.log("customization choice propagation tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
