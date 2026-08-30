const assert = require("assert");

const { buildProductModule } = require("../src/modules/m_products");
const categoryModule = require("../src/modules/m_category");
const servicePoints = require("../src/modules/m_servicePoints");

const createConnection = (handlers) => {
  const calls = [];
  return {
    calls,
    query(sql, params, callback) {
      calls.push({ sql, params });
      const handler = handlers.find(({ match }) => sql.includes(match));
      const result = handler ? handler.result(sql, params) : [];
      if (callback) return callback(null, result);
      return Promise.resolve([result]);
    },
  };
};

(async () => {
  {
    const connection = createConnection([
      {
        match: "SELECT products.*, category.name AS category",
        result: () => [],
      },
    ]);
    await buildProductModule({
      connection,
      getResolvedProductConfigurations: async () => new Map(),
    }).mAllProduct(7);

    assert.ok(
      connection.calls[0].sql.includes("ORDER BY products.sort_order ASC"),
      "products are read by display order",
    );
  }

  {
    const connection = createConnection([
      {
        match: "SELECT id FROM products",
        result: () => [{ id: 3 }, { id: 1 }, { id: 2 }],
      },
      {
        match: "UPDATE products SET sort_order",
        result: () => ({ affectedRows: 1 }),
      },
    ]);

    await buildProductModule({
      connection,
      withTransaction: (callback) => callback(connection),
    }).mReorderProducts(7, [3, 1, 2]);

    const updates = connection.calls.filter((call) =>
      call.sql.includes("UPDATE products SET sort_order"),
    );
    assert.deepStrictEqual(
      updates.map((call) => call.params),
      [
        [10, 3, 7],
        [20, 1, 7],
        [30, 2, 7],
      ],
    );
  }

  {
    const connection = createConnection([
      {
        match: "SELECT id FROM products",
        result: () => [{ id: 3 }, { id: 1 }],
      },
    ]);

    await assert.rejects(
      () => buildProductModule({
        connection,
        withTransaction: (callback) => callback(connection),
      }).mReorderProducts(7, [3, 1, 2]),
      /Invalid product order/,
    );
  }

  {
    const connection = createConnection([
      {
        match: "SELECT * FROM category",
        result: () => [],
      },
    ]);

    await categoryModule.buildCategoryModule({ connection }).mAllCategory(7);
    assert.ok(
      connection.calls[0].sql.includes("ORDER BY sort_order ASC"),
      "categories are read by display order",
    );
  }

  {
    const connection = createConnection([
      {
        match: "SELECT id FROM category",
        result: () => [{ id: 5 }, { id: 4 }],
      },
      {
        match: "UPDATE category SET sort_order",
        result: () => ({ affectedRows: 1 }),
      },
    ]);

    await categoryModule.buildCategoryModule({ connection }).mReorderCategories(7, [5, 4]);

    const updates = connection.calls.filter((call) =>
      call.sql.includes("UPDATE category SET sort_order"),
    );
    assert.deepStrictEqual(
      updates.map((call) => call.params),
      [
        [10, 5, 7],
        [20, 4, 7],
      ],
    );
  }

  {
    const connection = createConnection([
      {
        match: "SELECT `id` FROM `service_points`",
        result: () => [{ id: 8 }, { id: 6 }],
      },
      {
        match: "UPDATE `service_points` SET `sort_order`",
        result: () => ({ affectedRows: 1 }),
      },
    ]);

    await servicePoints.buildServicePointModule({ connection }).reorderTablePoints({
      shopId: 7,
      ids: [8, 6],
    });

    const updates = connection.calls.filter((call) =>
      call.sql.includes("UPDATE `service_points` SET `sort_order`"),
    );
    assert.deepStrictEqual(
      updates.map((call) => call.params),
      [
        [10, 8, 7],
        [20, 6, 7],
      ],
    );
  }
})()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
