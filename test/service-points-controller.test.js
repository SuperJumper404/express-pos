const assert = require("assert");
const fs = require("fs");
const path = require("path");

const controllerPath = path.join(
  __dirname,
  "../src/controllers/c_servicePoints.js",
);
assert.ok(fs.existsSync(controllerPath), "service points controller must exist");

const { buildServicePointsController } = require(controllerPath);

const response = () => ({
  statusCode: null,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return payload;
  },
});

const points = [
  { id: 1, name: "Comptoir", type: "counter", is_system: 1 },
  { id: 2, name: "Click & Collect", type: "click_collect", is_system: 1 },
  { id: 3, name: "Table 8", type: "table", is_system: 0 },
];
const calls = [];
const controller = buildServicePointsController({
  listServicePoints: async () => points,
  createTablePoint: async (input) => {
    calls.push(input);
    return { id: 4, ...input };
  },
  findServicePoint: async ({ servicePointId }) =>
    points.find((point) => point.id === servicePointId) || null,
  updateTablePoint: async () => ({ affectedRows: 1 }),
  deleteTablePoint: async () => ({ affectedRows: 1 }),
});

(async () => {
  const createResponse = response();
  await controller.createTable(
    { shopid: 8, body: { name: "  Table 8  " } },
    createResponse,
  );
  assert.deepStrictEqual(calls[0], {
    shopId: 8,
    name: "Table 8",
    type: "table",
  });
  assert.strictEqual(createResponse.statusCode, 201);

  const deleteResponse = response();
  await controller.deleteTable(
    { shopid: 8, params: { id: "2" } },
    deleteResponse,
  );
  assert.strictEqual(deleteResponse.statusCode, 422);

  const listResponse = response();
  await controller.listPoints({ shopid: 8 }, listResponse);
  assert.deepStrictEqual(
    listResponse.payload.data.map((point) => point.name),
    ["Comptoir", "Click & Collect", "Table 8"],
  );

  console.log("service points controller tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
