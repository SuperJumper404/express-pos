const assert = require("assert");

require.cache[require.resolve("../src/config/db")] = {
  exports: { query: () => { throw new Error("unexpected legacy DB query"); } },
};

const { buildDeleteOrderController } = require("../src/controllers/c_orders");

const makeResponse = () => {
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return response;
};

const run = async () => {
  let archivedArgs;
  const controller = buildDeleteOrderController({
    findOrderById: async () => [{ id: 42, shopid: 7, status: 1 }],
    archiveOrder: async (...args) => {
      archivedArgs = args;
      return { affectedRows: 1 };
    },
  });
  const response = makeResponse();
  await controller({ params: { id: "42" }, shopid: 7, id: 99 }, response);

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.body.success, true);
  assert.deepStrictEqual(archivedArgs, [
    "42",
    undefined,
    7,
    { hiddenFromHistory: true, hiddenByUserId: 99 },
  ]);

  let archivedReadyOrder = false;
  let archivedReadyArgs;
  const readyController = buildDeleteOrderController({
    findOrderById: async () => [{ id: 43, shopid: 7, status: 3 }],
    archiveOrder: async (...args) => {
      archivedReadyOrder = true;
      archivedReadyArgs = args;
      return { affectedRows: 1 };
    },
  });
  const readyResponse = makeResponse();
  await readyController({ params: { id: "43" }, shopid: 7, id: 99 }, readyResponse);

  assert.strictEqual(readyResponse.statusCode, 200);
  assert.strictEqual(readyResponse.body.success, true);
  assert.strictEqual(archivedReadyOrder, true);
  assert.deepStrictEqual(archivedReadyArgs, [
    "43",
    undefined,
    7,
    { hiddenFromHistory: true, hiddenByUserId: 99 },
  ]);
};

run()
  .then(() => console.log("order delete hidden archive contracts passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
