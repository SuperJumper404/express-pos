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
  buildRegenerateOrderPaymentIntentController,
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

const makeEditingHarness = ({
  linkedStock = 5,
  legacy = false,
  stripe = false,
} = {}) => {
  const events = [];
  let state = {
    order: {
      ...order,
      subtotal: 10,
      payment_status: stripe ? "requires_payment" : "unpaid",
      payment_provider: stripe ? "stripe" : null,
      stripe_payment_intent_id: stripe ? "pi_old" : null,
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
      status: stripe ? "reserved" : "committed",
    }]]),
    movements: [],
    nextDetailId: 100,
    nextSnapshotId: 200,
  };
  let failSnapshots = false;

  const repository = {
    lockOrder: async ({ orderId, shopId }) => (
      events.push("lock-order"),
      Number(orderId) === state.order.id && Number(shopId) === state.order.shopid
        ? state.order
        : null
    ),
    lockDetails: async ({ orderId }) => {
      events.push("lock-details");
      return state.details.filter((row) => row.orderid === Number(orderId));
    },
    lockSnapshots: async ({ detailIds }) => {
      events.push("lock-snapshots");
      return state.snapshots.filter((row) => detailIds.includes(row.orderdetail_id));
    },
    lockReservations: async () => {
      events.push("lock-reservations");
      return [...state.reservations.values()];
    },
    lockProducts: async ({ productIds }) => {
      events.push("lock-products");
      return productIds
        .filter((id) => state.products.has(id))
        .map((id) => ({ id, stock: state.products.get(id) }));
    },
    adjustStock: async ({ productId, delta }) => {
      events.push("adjust-stock");
      const available = state.products.get(productId);
      if (available == null || available + delta < 0) return { affectedRows: 0 };
      state.products.set(productId, available + delta);
      return { affectedRows: 1 };
    },
    deleteSnapshots: async ({ detailIds }) => {
      events.push("delete-snapshots");
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
    events.push("begin");
    try {
      const result = await work({ transaction: true });
      events.push("commit");
      return result;
    } catch (error) {
      state = before;
      events.push("rollback");
      throw error;
    }
  };
  const quoteOrderItems = async ({ items }) => {
    events.push("quote");
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
    events,
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

const runPaymentRegenerationContracts = async () => {
  let harness = makeEditingHarness({ stripe: true });
  harness.state.order.payment_status = "unpaid";
  harness.state.order.stripe_payment_intent_id = null;
  harness.state.reservations.get(10).status = "released";
  harness.state.products.set(10, 1);
  const prepared = await harness.module.prepareOrderPaymentRegeneration({
    orderId: 42,
    shopId: 7,
  });
  assert.strictEqual(prepared.order.id, 42);
  assert.match(prepared.contentRevision, /^[a-f0-9]{64}$/);
  assert.strictEqual(harness.state.products.get(10), 0);
  assert.strictEqual(harness.state.reservations.get(10).status, "reserved");

  harness = makeEditingHarness({ stripe: true });
  harness.state.order.payment_status = "unpaid";
  harness.state.order.stripe_payment_intent_id = null;
  harness.state.reservations.get(10).status = "released";
  harness.state.products.set(10, 0);
  await assert.rejects(
    () => harness.module.prepareOrderPaymentRegeneration({
      orderId: 42,
      shopId: 7,
    }),
    (error) => error.code === "INSUFFICIENT_STOCK",
  );
};

const runPaymentRegenerationControllerContract = async () => {
  const calls = [];
  const controller = buildRegenerateOrderPaymentIntentController({
    prepareOrderPaymentRegeneration: async (input) => {
      calls.push(["prepare", input]);
      return {
        order: { id: 42, shopid: 7, subtotal: 20 },
        contentRevision: "revision",
      };
    },
    regenerateOrderPaymentIntent: async (input) => {
      calls.push(["generate", input]);
      return { paymentIntentId: "pi_new", clientSecret: "secret_new" };
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
  await controller({ params: { id: "42" }, shopid: 7 }, response);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.payload.data.paymentIntentId, "pi_new");
  assert.deepStrictEqual(calls[0], ["prepare", { orderId: 42, shopId: 7 }]);
  assert.strictEqual(calls[1][0], "generate");
};

const runUpdateControllerContract = async () => {
  let received;
  const controller = buildUpdateOrderItemsController({
    previewOrderEdit: async () => ({ total: 20 }),
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
  const { settlePendingPayment, ...receivedInput } = received;
  assert.strictEqual(typeof settlePendingPayment, "function");
  assert.deepStrictEqual(receivedInput, {
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

const runStripeEditControllerContract = async () => {
  let harness = makeEditingHarness({ stripe: true });
  const controller = buildUpdateOrderItemsController({
    updateOrderItems: harness.module.updateOrderItems,
    previewOrderEdit: harness.module.previewOrderEdit,
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => {
          harness.events.push("stripe-retrieve");
          return { id: "pi_old", status: "requires_payment_method" };
        },
        cancel: async () => {
          harness.events.push("stripe-cancel");
          return { id: "pi_old", status: "canceled" };
        },
      },
    }),
    stagePaymentReplacement: async ({ order }) => {
      harness.events.push("stage-payment");
      order.payment_status = "unpaid";
      order.stripe_payment_intent_id = null;
      return { ready: true };
    },
    regenerateOrderPaymentIntent: async () => {
      harness.events.push("generate-payment");
      return { paymentIntentId: "pi_new", clientSecret: "secret_new" };
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
      content_revision: harness.revision(),
      expected_total: 20,
      items: [{
        product_id: 10,
        quantity: 2,
        selected_product_step_choice_ids: [30],
      }],
    },
  }, response);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.payload.data.payment_refresh, "succeeded");
  assert.strictEqual(response.payload.data.payment.clientSecret, "secret_new");
  const position = (event) => harness.events.indexOf(event);
  assert.ok(position("quote") < position("begin"), "preview happens before the transaction");
  assert.ok(position("lock-order") < position("stripe-retrieve"));
  assert.ok(position("lock-products") < position("stripe-retrieve"));
  assert.ok(position("stripe-retrieve") < position("stripe-cancel"));
  assert.ok(position("stripe-cancel") < position("stage-payment"));
  assert.ok(position("stage-payment") < position("adjust-stock"));
  assert.ok(position("commit") < position("generate-payment"));

  harness = makeEditingHarness({ stripe: true });
  let succeededSyncs = 0;
  let controllerScenario = buildUpdateOrderItemsController({
    updateOrderItems: harness.module.updateOrderItems,
    previewOrderEdit: harness.module.previewOrderEdit,
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_old", status: "succeeded" }),
      },
    }),
    markPaymentSucceeded: async () => { succeededSyncs += 1; },
    stagePaymentReplacement: async () => {
      throw new Error("stage must not run");
    },
  });
  response.statusCode = null;
  response.payload = null;
  await controllerScenario({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: {
      content_revision: harness.revision(),
      expected_total: 20,
      items: [{ product_id: 10, quantity: 2, selected_product_step_choice_ids: [30] }],
    },
  }, response);
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(response.payload.data.code, "ORDER_NOT_EDITABLE");
  assert.strictEqual(succeededSyncs, 1);
  assert.strictEqual(harness.state.details[0].qty, 1);

  harness = makeEditingHarness({ stripe: true });
  controllerScenario = buildUpdateOrderItemsController({
    updateOrderItems: harness.module.updateOrderItems,
    previewOrderEdit: harness.module.previewOrderEdit,
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_old", status: "processing" }),
        cancel: async () => ({ id: "pi_old", status: "processing" }),
      },
    }),
  });
  response.statusCode = null;
  response.payload = null;
  await controllerScenario({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: {
      content_revision: harness.revision(),
      expected_total: 20,
      items: [{ product_id: 10, quantity: 2, selected_product_step_choice_ids: [30] }],
    },
  }, response);
  assert.strictEqual(response.statusCode, 409);
  assert.strictEqual(response.payload.data.code, "STRIPE_PAYMENT_NOT_SETTLED");
  assert.strictEqual(harness.state.details[0].qty, 1);

  harness = makeEditingHarness({ stripe: true });
  controllerScenario = buildUpdateOrderItemsController({
    updateOrderItems: harness.module.updateOrderItems,
    previewOrderEdit: harness.module.previewOrderEdit,
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_old", status: "requires_payment_method" }),
        cancel: async () => ({ id: "pi_old", status: "canceled" }),
      },
    }),
    stagePaymentReplacement: async ({ order }) => {
      order.payment_status = "unpaid";
      order.stripe_payment_intent_id = null;
      return { ready: true };
    },
    regenerateOrderPaymentIntent: async () => {
      throw new Error("Stripe create failed");
    },
    logger: { error: () => {} },
  });
  response.statusCode = null;
  response.payload = null;
  await controllerScenario({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: {
      content_revision: harness.revision(),
      expected_total: 20,
      items: [{ product_id: 10, quantity: 2, selected_product_step_choice_ids: [30] }],
    },
  }, response);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.payload.data.payment_refresh, "required");
  assert.strictEqual(response.payload.data.payment_status, "unpaid");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(response.payload.data, "payment"), false);

  harness = makeEditingHarness({ stripe: true });
  harness.failSnapshots = true;
  let recoveries = 0;
  controllerScenario = buildUpdateOrderItemsController({
    updateOrderItems: harness.module.updateOrderItems,
    previewOrderEdit: harness.module.previewOrderEdit,
    getStripe: () => ({
      paymentIntents: {
        retrieve: async () => ({ id: "pi_old", status: "requires_payment_method" }),
        cancel: async () => ({ id: "pi_old", status: "canceled" }),
      },
    }),
    stagePaymentReplacement: async ({ order }) => {
      order.payment_status = "unpaid";
      order.stripe_payment_intent_id = null;
      return { ready: true };
    },
    recoverCanceledEditPayment: async () => {
      recoveries += 1;
      harness.state.order.payment_status = "unpaid";
      harness.state.order.stripe_payment_intent_id = null;
      return { recovered: true };
    },
    logger: { error: () => {} },
  });
  response.statusCode = null;
  response.payload = null;
  await controllerScenario({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: {
      content_revision: harness.revision(),
      expected_total: 20,
      items: [{ product_id: 10, quantity: 2, selected_product_step_choice_ids: [30] }],
    },
  }, response);
  assert.strictEqual(response.statusCode, 500);
  assert.strictEqual(response.payload.data.payment_refresh, "required");
  assert.strictEqual(recoveries, 1);
  assert.strictEqual(harness.state.order.payment_status, "unpaid");
  assert.strictEqual(harness.state.order.stripe_payment_intent_id, null);
  assert.strictEqual(harness.state.details[0].qty, 1, "failed edit content rolled back");
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
const stripeRouterSource = fs.readFileSync(
  require.resolve("../src/routers/r_stripe"),
  "utf8",
);
assert.match(
  stripeRouterSource,
  /"\/stripe\/payment-intents\/orders\/:id\/regenerate"[\s\S]*authentication,[\s\S]*orderEditing\.regenerateOrderPaymentIntent/,
);

runReadContracts()
  .then(runScopedDetailContract)
  .then(runTransactionalEditingContracts)
  .then(runPaymentRegenerationContracts)
  .then(runPaymentRegenerationControllerContract)
  .then(runUpdateControllerContract)
  .then(runStripeEditControllerContract)
  .then(runTransitionContracts)
  .then(runStatusControllerContract)
  .then(() => console.log("orderEditing tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
