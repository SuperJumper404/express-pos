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
const {
  buildUpdateOrderItemsController,
} = require("../src/controllers/c_orderEditing");
const {
  buildOrderTransitionModule,
} = require("../src/modules/m_orderTransitions");
const { buildUpdateOrderController } = require("../src/controllers/c_orders");

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

const cloneEditingState = (state) => ({
  order: { ...state.order },
  details: state.details.map((row) => ({ ...row })),
  snapshots: state.snapshots.map((row) => ({ ...row })),
  products: new Map(state.products),
  reservations: new Map(
    [...state.reservations].map(([id, row]) => [id, { ...row }]),
  ),
  movements: state.movements.map((row) => ({ ...row })),
  nextDetailId: state.nextDetailId,
  nextSnapshotId: state.nextSnapshotId,
});

const makeEditingHarness = ({ linkedStock = 5, legacy = false } = {}) => {
  let state = {
    order: {
      ...order,
      subtotal: 10,
      client_order_payload_hash: "original-checkout-hash",
    },
    details: [{
      id: 70,
      orderid: 42,
      productid: 10,
      qty: 1,
      price: 10,
      total: 10,
    }],
    snapshots: [],
    products: new Map([[10, 7], [11, linkedStock]]),
    reservations: legacy ? new Map() : new Map([[10, {
      order_id: 42,
      product_id: 10,
      quantity: 1,
      status: "committed",
    }]]),
    movements: [],
    nextDetailId: 100,
    nextSnapshotId: 200,
  };
  let failSnapshots = false;

  const repository = {
    lockOrder: async ({ orderId, shopId }) => (
      Number(orderId) === state.order.id && Number(shopId) === state.order.shopid
        ? state.order
        : null
    ),
    lockDetails: async ({ orderId }) => state.details.filter(
      (row) => row.orderid === Number(orderId),
    ),
    lockSnapshots: async ({ detailIds }) => state.snapshots.filter(
      (row) => detailIds.includes(row.orderdetail_id),
    ),
    lockReservations: async () => [...state.reservations.values()],
    lockProducts: async ({ productIds }) => productIds
      .filter((id) => state.products.has(id))
      .map((id) => ({ id, stock: state.products.get(id) })),
    adjustStock: async ({ productId, delta }) => {
      const available = state.products.get(productId);
      if (available == null || available + delta < 0) return { affectedRows: 0 };
      state.products.set(productId, available + delta);
      return { affectedRows: 1 };
    },
    deleteSnapshots: async ({ detailIds }) => {
      state.snapshots = state.snapshots.filter(
        (row) => !detailIds.includes(row.orderdetail_id),
      );
      return { affectedRows: detailIds.length };
    },
    deleteDetails: async ({ orderId }) => {
      state.details = state.details.filter((row) => row.orderid !== Number(orderId));
      return { affectedRows: 1 };
    },
    insertDetail: async ({ detail }) => {
      const id = state.nextDetailId++;
      state.details.push({ id, ...detail });
      return { insertId: id };
    },
    insertSnapshot: async ({ snapshot }) => {
      if (failSnapshots) throw new Error("snapshot write failure");
      const id = state.nextSnapshotId++;
      state.snapshots.push({ id, ...snapshot });
      return { insertId: id };
    },
    updateOrderTotal: async ({ total, finished }) => {
      state.order.subtotal = total;
      state.order.finished = finished;
      return { affectedRows: 1 };
    },
    upsertReservation: async ({ reservation }) => {
      state.reservations.set(reservation.product_id, { ...reservation });
      return { affectedRows: 1 };
    },
    insertMovement: async ({ movement }) => {
      state.movements.push({ ...movement });
      return { insertId: state.movements.length };
    },
  };
  const withTransaction = async (work) => {
    const before = cloneEditingState(state);
    try {
      return await work({ transaction: true });
    } catch (error) {
      state = before;
      throw error;
    }
  };
  const quoteOrderItems = async ({ items }) => {
    const resolvedItems = items.map((item) => {
      const selected = item.selectedChoiceIds.includes(30);
      const steps = [{
        product_step_id: 20,
        position: 0,
        choices: [{ product_step_choice_id: 30, position: 0 }],
      }];
      return {
        ...item,
        product: { id: item.productId },
        steps,
        unitPrice: 10,
        lineTotal: 10 * item.quantity,
        selectedChoices: selected ? [{
          product_step_choice_id: 30,
          step_id: 20,
          step_name: "Boisson",
          choice_type: "linked_product",
          choice_name: "Cola",
          extra_price: 0,
          linked_product_id: 11,
        }] : [],
      };
    });
    const total = resolvedItems.reduce((sum, item) => sum + item.lineTotal, 0);
    const requirements = new Map();
    const add = (id, quantity) => requirements.set(
      id,
      (requirements.get(id) || 0) + quantity,
    );
    for (const item of resolvedItems) {
      add(item.productId, item.quantity);
      if (item.selectedChoiceIds.includes(30)) add(11, item.quantity);
    }
    return {
      resolvedItems,
      total,
      requirements,
      serverQuote: {
        total,
        items: resolvedItems.map((item) => ({
          product_id: item.productId,
          quantity: item.quantity,
          selected_product_step_choice_ids: item.selectedChoiceIds,
          unit_price: item.unitPrice,
          total: item.lineTotal,
        })),
      },
    };
  };
  const module = buildOrderEditingModule({
    repository,
    quoteOrderItems,
    withTransaction,
    now: () => new Date("2026-07-24T12:00:00.000Z"),
    reservationTtlMinutes: 15,
  });
  const revision = () => buildContentRevision({
    order: state.order,
    details: state.details,
    snapshots: state.snapshots,
  });
  const update = (overrides = {}) => module.updateOrderItems({
    orderId: 42,
    shopId: 7,
    actorId: 9,
    contentRevision: revision(),
    expectedTotal: 20,
    items: [{ productId: 10, quantity: 2, selectedChoiceIds: [30] }],
    ...overrides,
  });
  return {
    module,
    revision,
    update,
    get state() { return state; },
    set failSnapshots(value) { failSnapshots = value; },
    snapshot: () => cloneEditingState(state),
  };
};

const runTransactionalEditingContracts = async () => {
  let harness = makeEditingHarness();
  const updated = await harness.update();
  assert.strictEqual(updated.total, 20);
  assert.strictEqual(harness.state.products.get(10), 6, "one extra parent consumed");
  assert.strictEqual(harness.state.products.get(11), 3, "two linked choices consumed");
  assert.strictEqual(harness.state.order.subtotal, 20);
  assert.strictEqual(
    harness.state.order.client_order_payload_hash,
    "original-checkout-hash",
    "checkout idempotency claim remains unchanged",
  );
  assert.strictEqual(harness.state.details.length, 1);
  assert.strictEqual(harness.state.snapshots.length, 1);
  assert.strictEqual(harness.state.reservations.get(10).quantity, 2);
  assert.strictEqual(harness.state.reservations.get(11).quantity, 2);

  await assert.rejects(
    () => harness.module.updateOrderItems({
      orderId: 42,
      shopId: 7,
      actorId: 9,
      contentRevision: "stale",
      expectedTotal: 20,
      items: [{ productId: 10, quantity: 2, selectedChoiceIds: [30] }],
    }),
    (error) => error.code === "ORDER_EDIT_CONFLICT",
  );

  const beforeFailure = harness.snapshot();
  harness.failSnapshots = true;
  await assert.rejects(() => harness.update(), /snapshot write failure/);
  assert.deepStrictEqual(harness.snapshot(), beforeFailure, "transaction rolled back");

  assert.throws(
    () => harness.update({ items: [] }),
    (error) => error.code === "ORDER_ITEMS_REQUIRED",
  );
  await assert.rejects(
    () => harness.update({ expectedTotal: 19 }),
    (error) => error.code === "ORDER_REPRICE_REQUIRED"
      && error.server_quote.total === 20,
  );

  harness = makeEditingHarness({ linkedStock: 1 });
  await assert.rejects(
    () => harness.update(),
    (error) => error.code === "INSUFFICIENT_STOCK",
  );

  harness = makeEditingHarness();
  await harness.update();
  await harness.update({
    contentRevision: harness.revision(),
    expectedTotal: 10,
    items: [{ productId: 10, quantity: 1, selectedChoiceIds: [] }],
  });
  assert.strictEqual(harness.state.products.get(10), 7, "parent stock restored");
  assert.strictEqual(harness.state.products.get(11), 5, "linked stock restored");
  assert.strictEqual(harness.state.reservations.get(11).quantity, 0);

  harness = makeEditingHarness({ legacy: true });
  await harness.update();
  assert.strictEqual(harness.state.reservations.get(10).quantity, 2);
  assert.strictEqual(harness.state.reservations.get(11).quantity, 2);
};

const runUpdateControllerContract = async () => {
  let received;
  const controller = buildUpdateOrderItemsController({
    updateOrderItems: async (input) => {
      received = input;
      return { order_id: 42, total: 20 };
    },
  });
  const response = {
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
  };
  await controller({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: {
      content_revision: "revision",
      expected_total: 20,
      items: [{ product_id: 10, quantity: 2 }],
    },
  }, response);
  assert.deepStrictEqual(received, {
    orderId: 42,
    shopId: 7,
    actorId: 9,
    contentRevision: "revision",
    expectedTotal: 20,
    items: [{ product_id: 10, quantity: 2 }],
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.payload.data.order_id, 42);
};

const runTransitionContracts = async () => {
  const events = [];
  const transitions = buildOrderTransitionModule({
    withTransaction: async (work) => {
      events.push("begin");
      const result = await work({ transaction: true });
      events.push("commit");
      return result;
    },
    repository: {
      lockOrder: async ({ orderId, shopId }) => {
        events.push(["lock", orderId, shopId]);
        return { id: 42, shopid: 7, status: 1, payment_status: "unpaid" };
      },
      updateStatus: async ({ nextStatus }) => {
        events.push(["status", nextStatus]);
        return { affectedRows: 1 };
      },
    },
  });
  await transitions.transitionOrderStatus({
    orderId: 42,
    shopId: 7,
    actorId: 9,
    nextStatus: 2,
  });
  assert.deepStrictEqual(events, [
    "begin",
    ["lock", 42, 7],
    ["status", 2],
    "commit",
  ]);

  const invalid = buildOrderTransitionModule({
    withTransaction: async (work) => work({ transaction: true }),
    repository: {
      lockOrder: async () => ({ id: 42, shopid: 7, status: 1 }),
      updateStatus: async () => ({ affectedRows: 1 }),
    },
  });
  await assert.rejects(
    () => invalid.transitionOrderStatus({
      orderId: 42,
      shopId: 7,
      actorId: 9,
      nextStatus: 3,
    }),
    (error) => error.code === "ORDER_STATUS_TRANSITION_INVALID",
  );

  const paidOrder = {
    id: 42,
    shopid: 7,
    status: 1,
    payment_status: "paid",
  };
  const paidTransition = buildOrderTransitionModule({
    withTransaction: async (work) => work({ transaction: true }),
    repository: {
      lockOrder: async () => paidOrder,
      updateStatus: async ({ nextStatus }) => {
        paidOrder.status = nextStatus;
        return { affectedRows: 1 };
      },
    },
  });
  await paidTransition.transitionOrderStatus({
    orderId: 42,
    shopId: 7,
    actorId: 9,
    nextStatus: 2,
  });
  assert.strictEqual(paidOrder.status, 2);
  assert.strictEqual(isEditableOrder(paidOrder), false);
};

const runStatusControllerContract = async () => {
  let received;
  const controller = buildUpdateOrderController({
    transitionOrderStatus: async (input) => {
      received = input;
      return { result: { affectedRows: 1 } };
    },
  });
  const response = {
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
  };
  await controller({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: { operator: 999, status: 2, subtotal: 999 },
  }, response);
  assert.deepStrictEqual(received, {
    orderId: 42,
    shopId: 7,
    actorId: 9,
    nextStatus: 2,
  });
  assert.strictEqual(response.statusCode, 200);

  const events = [];
  const cancelController = buildUpdateOrderController({
    findOrderById: async (orderId, shopId) => {
      events.push(["find", orderId, shopId]);
      return [{ id: orderId, shopid: shopId, status: 1 }];
    },
    cancelPendingStripePayment: async () => events.push("cancel-payment"),
    transitionOrderStatus: async ({ nextStatus }) => {
      events.push(["transition", nextStatus]);
      return { result: { affectedRows: 1 } };
    },
  });
  await cancelController({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: { status: 4 },
  }, response);
  assert.deepStrictEqual(events, [
    ["find", 42, 7],
    "cancel-payment",
    ["transition", 4],
  ]);
};

const routerSource = fs.readFileSync(require.resolve("../src/routers/r_orders"), "utf8");
assert.match(routerSource, /\.get\("\/orders\/:id\/edit", authentication,/);
assert.match(routerSource, /\.patch\("\/orders\/:id\/items", authentication,/);

runReadContracts()
  .then(runScopedDetailContract)
  .then(runTransactionalEditingContracts)
  .then(runUpdateControllerContract)
  .then(runTransitionContracts)
  .then(runStatusControllerContract)
  .then(() => console.log("orderEditing tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
