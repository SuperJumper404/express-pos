const assert = require("assert");
const {
  validateStockItemPayload,
  validateReplenishmentPayload,
  validateInventoryPayload,
  mapStockItemResponse,
  parseTaken,
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

assert.strictEqual(parseTaken(true), true);
assert.strictEqual(parseTaken(false), false);
assert.strictEqual(parseTaken("true"), true);
assert.strictEqual(parseTaken("false"), false);
assert.strictEqual(parseTaken(" FALSE "), false);
assert.strictEqual(parseTaken("1"), true);
assert.strictEqual(parseTaken("0"), false);
assert.throws(() => parseTaken("oui"), /La valeur taken doit etre un booleen/);

const controllerPath = require.resolve("../src/controllers/c_stockInventory");
const stockInventoryPath = require.resolve("../src/modules/m_stockInventory");
const originalController = require.cache[controllerPath];
const originalStockInventory = require.cache[stockInventoryPath].exports;

const responseRecorder = () => {
  const response = {};
  return {
    response,
    res: {
      status: (code) => {
        response.code = code;
        return {
          json: (body) => {
            response.body = body;
            return body;
          },
        };
      },
    },
  };
};

const withStockInventory = async (stockInventory, work) => {
  require.cache[stockInventoryPath].exports = stockInventory;
  delete require.cache[controllerPath];
  try {
    await work(require(controllerPath));
  } finally {
    require.cache[stockInventoryPath].exports = originalStockInventory;
    require.cache[controllerPath] = originalController;
  }
};

(async () => {
  await withStockInventory({
    updateItem: async () => ({ affectedRows: 0 }),
  }, async (controller) => {
    const { res, response } = responseRecorder();
    await controller.updateItem({
      shopid: 1,
      params: { id: 10 },
      body: {
        name: "Fromage",
        unit: "paquet",
        current_stock: 2,
        minimum_stock: 1,
        target_stock: 4,
      },
    }, res);
    assert.strictEqual(response.code, 404);
  });

  let taken;
  await withStockInventory({
    setShoppingListTaken: async (data) => {
      taken = data.taken;
      return { affectedRows: 0 };
    },
  }, async (controller) => {
    const { res, response } = responseRecorder();
    await controller.setShoppingListTaken({
      shopid: 1,
      params: { id: 10 },
      body: { taken: "false" },
    }, res);
    assert.strictEqual(taken, false);
    assert.strictEqual(response.code, 404);
  });

  await withStockInventory({}, async (controller) => {
    const { res, response } = responseRecorder();
    await controller.setShoppingListTaken({
      shopid: 1,
      params: { id: 10 },
      body: { taken: "oui" },
    }, res);
    assert.strictEqual(response.code, 400);
  });

  console.log("stock inventory controller tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
