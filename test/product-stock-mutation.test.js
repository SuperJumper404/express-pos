const assert = require("assert");
const { adjustProductStock } = require("../src/helpers/productStockMutation");
const { buildStockModule } = require("../src/modules/m_stocks");
const fs = require("fs");
const path = require("path");

const legacyStockSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "m_stocks.js"),
  "utf8",
);
assert.match(legacyStockSource, /withTransaction/);
assert.match(legacyStockSource, /UPDATE stock_items/);

const run = async () => {
  const state = {
    products: new Map([[10, 2]]),
    stockItems: new Map([[10, 2]]),
  };
  const query = async (sql, params) => {
    if (sql.includes("UPDATE products")) {
      const [delta, productId, shopId] = params;
      assert.strictEqual(shopId, 7);
      const current = state.products.get(productId);
      const guarded = sql.includes("stock >= ?");
      if (guarded && current < -delta) return { affectedRows: 0 };
      state.products.set(productId, current + delta);
      return { affectedRows: 1 };
    }
    if (sql.includes("UPDATE stock_items")) {
      const [productId, shopId] = params;
      assert.strictEqual(shopId, 7);
      state.stockItems.set(productId, state.products.get(productId));
      return { affectedRows: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };

  let result = await adjustProductStock({
    query,
    shopId: 7,
    productId: 10,
    delta: -2,
    allowShortage: false,
  });
  assert.strictEqual(result.affectedRows, 1);
  assert.strictEqual(state.products.get(10), 0);
  assert.strictEqual(state.stockItems.get(10), 0);

  result = await adjustProductStock({
    query,
    shopId: 7,
    productId: 10,
    delta: -1,
    allowShortage: false,
  });
  assert.strictEqual(result.affectedRows, 0);
  assert.strictEqual(state.products.get(10), 0);
  assert.strictEqual(state.stockItems.get(10), 0);

  result = await adjustProductStock({
    query,
    shopId: 7,
    productId: 10,
    delta: -1,
    allowShortage: true,
  });
  assert.strictEqual(result.affectedRows, 1);
  assert.strictEqual(state.products.get(10), -1);
  assert.strictEqual(state.stockItems.get(10), -1);

  const legacyQueries = [];
  const legacyModule = buildStockModule({
    runInTransaction: async (work) => work({
      query: async (sql, params) => {
        legacyQueries.push({ sql, params });
        return [{ affectedRows: 1 }];
      },
    }),
  });
  const legacyResult = await legacyModule.updateProductStock({
    productId: 10,
    category: "0",
    quantity: "3",
  });
  assert.strictEqual(legacyResult.affectedRows, 1);
  assert.strictEqual(legacyQueries.length, 2);
  assert.match(legacyQueries[0].sql, /UPDATE products SET stock = stock \+ \?/);
  assert.deepStrictEqual(legacyQueries[0].params, [3, 10]);
  assert.match(legacyQueries[1].sql, /UPDATE stock_items/);
  assert.deepStrictEqual(legacyQueries[1].params, [10]);

  console.log("product stock mutation tests passed");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
