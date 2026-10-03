const assert = require("assert");
const {
  createCustomizationChoice,
  deleteCustomizationChoicePermanently,
} = require("../src/modules/m_customizations");

const calls = [];
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
