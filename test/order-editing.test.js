const assert = require("assert");
const fs = require("fs");
const {
  buildContentRevision,
  buildOrderEditingModule,
  isEditableOrder,
} = require("../src/modules/m_orderEditing");
const callbackDbPath = require.resolve("../src/config/db");
require.cache[callbackDbPath] = {
  exports: { query: () => { throw new Error("unexpected legacy DB query"); } },
};
const { buildOrderArchiveModule } = require("../src/modules/m_orders");

const order = {
  id: 42,
  shopid: 7,
  ordernumber: "0042",
  status: 1,
  payment_status: "unpaid",
  payment_provider: null,
  subtotal: "11.50",
};
const details = [{
  id: 70,
  orderid: 42,
  productid: 10,
  name: "Menu",
  image: "menu.webp",
  qty: 1,
  price: "11.50",
  total: "11.50",
}];
const snapshots = [{
  orderdetail_id: 70,
  product_customization_step_id: 20,
  product_customization_step_choice_id: 30,
  step_name: "Boisson",
  step_position: 0,
  choice_type: "simple",
  choice_name: "Cola",
  choice_position: 0,
  unit_extra_price: "1.50",
  linked_product_id: null,
}];

assert.strictEqual(isEditableOrder(order), true);
assert.strictEqual(isEditableOrder({ ...order, status: 2 }), false);
assert.strictEqual(isEditableOrder({ ...order, payment_status: "paid" }), false);
assert.strictEqual(
  buildContentRevision({ order, details, snapshots }),
  buildContentRevision({
    order,
    details: details.map((row) => ({ ...row })),
    snapshots,
  }),
);

const runReadContracts = async () => {
  const calls = [];
  const module = buildOrderEditingModule({
    repository: {
      findOrder: async (options) => {
        calls.push(options);
        return order;
      },
      findDetails: async () => details,
      findSnapshots: async () => snapshots,
    },
    getResolvedProductConfigurations: async () => new Map([[10, [{
      product_step_id: 20,
      choices: [{
        product_step_choice_id: 30,
        active: 1,
        available: true,
      }],
    }]]]),
  });
  const result = await module.getEditableOrder({ orderId: 42, shopId: 7 });
  assert.strictEqual(calls[0].shopId, 7);
  assert.deepStrictEqual(result.items[0].selected_product_step_choice_ids, [30]);
  assert.strictEqual(result.items[0].requires_reconfiguration, false);
  assert.match(result.content_revision, /^[a-f0-9]{64}$/);

  snapshots[0].product_customization_step_choice_id = 999;
  const legacy = await module.getEditableOrder({ orderId: 42, shopId: 7 });
  assert.strictEqual(legacy.items[0].requires_reconfiguration, true);
  snapshots[0].product_customization_step_choice_id = 30;

  const lockedModule = buildOrderEditingModule({
    repository: {
      findOrder: async () => ({ ...order, payment_status: "paid" }),
      findDetails: async () => details,
      findSnapshots: async () => snapshots,
    },
  });
  await assert.rejects(
    () => lockedModule.getEditableOrder({ orderId: 42, shopId: 7 }),
    (error) => error.code === "ORDER_NOT_EDITABLE",
  );
};

const runScopedDetailContract = async () => {
  let received;
  const module = buildOrderArchiveModule({
    repository: {
      findActiveOrderDetails: async (options) => {
        received = options;
        return [];
      },
      findActiveSnapshots: async () => [],
      findLegacyCustomizations: async () => [],
    },
  });
  await module.mDetailOrder(42, 7);
  assert.strictEqual(received.orderId, 42);
  assert.strictEqual(received.shopId, 7);
};

const routerSource = fs.readFileSync(require.resolve("../src/routers/r_orders"), "utf8");
assert.match(routerSource, /\.get\("\/orders\/:id\/edit", authentication,/);

runReadContracts()
  .then(runScopedDetailContract)
  .then(() => console.log("orderEditing tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
