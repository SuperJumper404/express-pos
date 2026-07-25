const assert = require("assert");
const fs = require("fs");
const DomainError = require("../src/helpers/domainError");
const { ORDER_STATUSES } = require("../src/helpers/orderStatus");
const {
  buildOrderEditingModule,
  buildContentRevision,
  isOrderEditable,
} = require("../src/modules/m_orderEditing");
const {
  buildOrderEditingController,
  buildAmendOrderController,
} = require("../src/controllers/c_orderEditing");
const callbackDbPath = require.resolve("../src/config/db");
require.cache[callbackDbPath] = {
  exports: { query: () => { throw new Error("unexpected legacy DB query"); } },
};
const { buildUpdateOrderController } = require("../src/controllers/c_orders");
const {
  buildOrderTransitionModule,
} = require("../src/modules/m_orderTransitions");

const makeResponse = () => {
  const response = {};
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (payload) => {
    response.payload = payload;
    return response;
  };
  return response;
};

const buildHarness = () => {
  const orders = [{
    id: 42,
    shopid: 7,
    status: 1,
    payment_status: "unpaid",
    payment_provider: "cash",
    ordernumber: "0042",
    customer: "Ada",
    subtotal: "23.00",
  }, {
    id: 43,
    shopid: 7,
    status: 1,
    payment_status: "requires_payment",
    payment_provider: "stripe",
    ordernumber: "0043",
    subtotal: "8.00",
  }, {
    id: 44,
    shopid: 7,
    status: 1,
    payment_status: "paid",
  }, {
    id: 45,
    shopid: 7,
    status: 2,
    payment_status: "unpaid",
  }, {
    id: 46,
    shopid: 9,
    status: 1,
    payment_status: "unpaid",
  }];
  const details = [{
    id: 70,
    orderid: 42,
    productid: 10,
    qty: 2,
    price: "11.50",
    total: "23.00",
  }, {
    id: 71,
    orderid: 42,
    productid: 20,
    qty: 1,
    price: "5.00",
    total: "5.00",
  }];
  const snapshots = [{
    id: 1,
    orderdetail_id: 70,
    product_customization_step_id: 5,
    product_customization_step_choice_id: 8,
    step_name: "Boisson",
    step_position: 1,
    choice_type: "linked_product",
    choice_name: "Cola",
    choice_position: 1,
    unit_extra_price: "1.50",
    linked_product_id: 11,
  }];
  const legacyCustomizations = [{
    order_details_id: 71,
    product_choice_id: 12,
    name: "Ancien choix",
    price: "1.25",
  }];
  const calls = [];
  const editing = buildOrderEditingModule({
    repository: {
      findOrder: async ({ orderId, shopId }) => {
        calls.push(["findOrder", orderId, shopId]);
        return orders.find((order) => (
          order.id === Number(orderId) && order.shopid === Number(shopId)
        )) || null;
      },
      findOrderDetails: async ({ orderId, shopId }) => {
        calls.push(["findOrderDetails", orderId, shopId]);
        return details.filter((detail) => detail.orderid === Number(orderId));
      },
      findSnapshots: async ({ detailIds, shopId }) => {
        calls.push(["findSnapshots", detailIds, shopId]);
        return snapshots.filter((snapshot) => detailIds.includes(snapshot.orderdetail_id));
      },
      findLegacyCustomizations: async ({ detailIds, shopId }) => {
        calls.push(["findLegacyCustomizations", detailIds, shopId]);
        return legacyCustomizations.filter((selection) => (
          detailIds.includes(selection.order_details_id)
        ));
      },
    },
  });
  return { calls, editing };
};

const runEligibilityContracts = () => {
  assert.strictEqual(isOrderEditable({ status: 1, payment_status: "unpaid" }), true);
  assert.strictEqual(isOrderEditable({ status: 1, payment_status: "requires_payment" }), true);
  assert.strictEqual(isOrderEditable({ status: 1, payment_status: "paid" }), false);
  assert.strictEqual(isOrderEditable({ status: 2, payment_status: "unpaid" }), false);
};

const runRevisionContracts = () => {
  const order = { id: 42 };
  const ordered = [{
    id: 71,
    productid: 20,
    qty: 1,
    selections: [{ product_customization_step_choice_id: 12 }],
  }, {
    id: 70,
    productid: 10,
    qty: 2,
    selections: [
      { product_customization_step_choice_id: 9 },
      { product_customization_step_choice_id: 8 },
    ],
  }];
  const reordered = [
    { ...ordered[1], selections: [...ordered[1].selections].reverse() },
    ordered[0],
  ];
  assert.strictEqual(buildContentRevision(order, ordered), buildContentRevision(order, reordered));
};

const runEditableReadContracts = async () => {
  const { calls, editing } = buildHarness();
  const unpaid = await editing.getEditableOrder({ orderId: 42, shopId: 7 });
  assert.strictEqual(unpaid.order.id, 42);
  assert.strictEqual(unpaid.order.payment_status, "unpaid");
  assert.strictEqual(unpaid.items[0].orderdetail_id, 70);
  assert.strictEqual(unpaid.items[0].product_id, 10);
  assert.strictEqual(unpaid.items[0].quantity, 2);
  assert.strictEqual(
    unpaid.items[0].selections[0].product_customization_step_choice_id,
    8,
  );
  assert.strictEqual(unpaid.items[0].historical_customizations[0].choice_name, "Cola");
  assert.strictEqual(unpaid.items[0].requires_reconfiguration, false);
  assert.strictEqual(unpaid.items[1].selections[0].product_customization_step_choice_id, null);
  assert.strictEqual(unpaid.items[1].historical_customizations[0].name, "Ancien choix");
  assert.strictEqual(unpaid.items[1].requires_reconfiguration, true);
  assert.match(unpaid.content_revision, /^[a-f0-9]{64}$/);

  const requiresPayment = await editing.getEditableOrder({ orderId: 43, shopId: 7 });
  assert.strictEqual(requiresPayment.order.payment_status, "requires_payment");
  await assert.rejects(
    () => editing.getEditableOrder({ orderId: 44, shopId: 7 }),
    (error) => error.status === 422 && error.code === "ORDER_NOT_EDITABLE",
  );
  await assert.rejects(
    () => editing.getEditableOrder({ orderId: 45, shopId: 7 }),
    (error) => error.status === 422 && error.code === "ORDER_NOT_EDITABLE",
  );
  assert.strictEqual(await editing.getEditableOrder({ orderId: 46, shopId: 7 }), null);
  assert.deepStrictEqual(calls.find(([name, id]) => name === "findOrder" && id === 46), [
    "findOrder",
    46,
    7,
  ]);
};

const runControllerContracts = async () => {
  const controller = buildOrderEditingController({
    getEditableOrder: async () => {
      throw new DomainError(422, "ORDER_NOT_EDITABLE", "Commande non modifiable.");
    },
    logger: { error: () => {} },
  });
  const response = makeResponse();
  await controller({ params: { id: "42" }, shopid: 7 }, response);
  assert.strictEqual(response.statusCode, 422);
  assert.deepStrictEqual(response.payload.data, { code: "ORDER_NOT_EDITABLE" });
};

const runRouterContract = () => {
  const routerSource = fs.readFileSync(require.resolve("../src/routers/r_orders"), "utf8");
  assert.match(
    routerSource,
    /\.get\("\/orders\/:id\/edit", authentication, orderEditing\.getEditableOrder\)/,
  );
  assert.match(
    routerSource,
    /\.patch\("\/orders\/:id\/items", authentication, orderEditing\.amendOrder\)/,
  );
};

const cloneAmendState = (state) => ({
  order: { ...state.order },
  details: state.details.map((row) => ({ ...row })),
  snapshots: state.snapshots.map((row) => ({ ...row })),
  legacyCustomizations: state.legacyCustomizations.map((row) => ({ ...row })),
  reservations: state.reservations.map((row) => ({ ...row })),
  products: new Map([...state.products].map(([id, stock]) => [id, stock])),
  movements: state.movements.map((row) => ({ ...row })),
  nextDetailId: state.nextDetailId,
  nextSnapshotId: state.nextSnapshotId,
});

const makeAmendHarness = ({
  product11Stock = 1,
  product12Stock = 5,
  failSnapshotInsert = false,
  legacy = false,
  reservationsReleased = false,
} = {}) => {
  let state = {
    order: {
      id: 42,
      shopid: 7,
      status: 1,
      payment_status: "unpaid",
      payment_provider: "cash",
      ordernumber: "0042",
      subtotal: "27.00",
    },
    details: [{
      id: 70, orderid: 42, productid: 10, qty: 2, price: 11, total: 22,
    }, {
      id: 71, orderid: 42, productid: 20, qty: 1, price: 5, total: 5,
    }],
    snapshots: [{
      id: 1,
      orderdetail_id: 70,
      product_customization_step_id: 5,
      product_customization_step_choice_id: 101,
      step_name: "Boisson",
      step_position: 1,
      choice_type: "linked_product",
      choice_name: "Cola",
      choice_position: 1,
      unit_extra_price: 1,
      linked_product_id: 11,
    }],
    legacyCustomizations: legacy ? [{
      id: 1,
      order_id: 42,
      order_details_id: 71,
      product_choice_id: 77,
      name: "Ancien choix",
      price: "1.25",
    }] : [],
    reservations: [
      { id: 1, order_id: 42, product_id: 10, quantity: 2, status: reservationsReleased ? "released" : "committed" },
      { id: 2, order_id: 42, product_id: 11, quantity: 2, status: reservationsReleased ? "released" : "committed" },
      { id: 3, order_id: 42, product_id: 20, quantity: 1, status: reservationsReleased ? "released" : "committed" },
    ],
    products: new Map([[10, 5], [11, product11Stock], [12, product12Stock], [20, 4], [30, 5]]),
    movements: [],
    nextDetailId: 100,
    nextSnapshotId: 200,
  };
  const events = [];
  const withTransaction = async (work) => {
    const before = cloneAmendState(state);
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
  const repository = {
    findOrder: async ({ orderId, shopId }) => (
      state.order.id === Number(orderId) && state.order.shopid === Number(shopId)
        ? { ...state.order }
        : null
    ),
    findOrderDetails: async ({ orderId }) => state.details
      .filter((row) => row.orderid === Number(orderId))
      .map((row) => ({ ...row })),
    findSnapshots: async ({ detailIds }) => state.snapshots
      .filter((row) => detailIds.includes(row.orderdetail_id))
      .map((row) => ({ ...row })),
    findLegacyCustomizations: async ({ detailIds }) => state.legacyCustomizations
      .filter((row) => detailIds.includes(row.order_details_id))
      .map((row) => ({ ...row })),
    lockOrder: async ({ orderId, shopId }) => {
      events.push("lock-order");
      return state.order.id === Number(orderId) && state.order.shopid === Number(shopId)
        ? { ...state.order }
        : null;
    },
    lockDetails: async ({ orderId }) => {
      events.push("lock-details");
      return state.details.filter((row) => row.orderid === Number(orderId)).map((row) => ({ ...row }));
    },
    lockSnapshots: async ({ detailIds }) => {
      events.push("lock-snapshots");
      return state.snapshots.filter((row) => detailIds.includes(row.orderdetail_id))
        .map((row) => ({ ...row }));
    },
    lockLegacyCustomizations: async ({ detailIds }) => {
      events.push("lock-legacy-customizations");
      return state.legacyCustomizations
        .filter((row) => detailIds.includes(row.order_details_id))
        .map((row) => ({ ...row }));
    },
    lockReservations: async ({ orderId }) => {
      events.push("lock-reservations");
      return state.reservations.filter((row) => row.order_id === Number(orderId))
        .map((row) => ({ ...row }));
    },
    lockProducts: async ({ shopId, productIds }) => {
      events.push(["lock-products", shopId, [...productIds]]);
      return productIds.filter((id) => state.products.has(id))
        .map((id) => ({ id, shopid: 7, stock: state.products.get(id) }));
    },
    adjustStock: async ({ shopId, productId, delta }) => {
      if (Number(shopId) !== 7) return { affectedRows: 0 };
      const current = state.products.get(Number(productId));
      if (current == null || current + Number(delta) < 0) return { affectedRows: 0 };
      state.products.set(Number(productId), current + Number(delta));
      events.push(["stock", Number(productId), Number(delta)]);
      return { affectedRows: 1 };
    },
    deleteSnapshots: async ({ detailIds }) => {
      state.snapshots = state.snapshots.filter((row) => !detailIds.includes(row.orderdetail_id));
      events.push("delete-snapshots");
      return { affectedRows: detailIds.length };
    },
    deleteLegacyCustomizations: async ({ orderId }) => {
      state.legacyCustomizations = state.legacyCustomizations
        .filter((row) => row.order_id !== Number(orderId));
      events.push("delete-legacy-customizations");
      return { affectedRows: 1 };
    },
    deleteDetails: async ({ orderId }) => {
      state.details = state.details.filter((row) => row.orderid !== Number(orderId));
      events.push("delete-details");
      return { affectedRows: 2 };
    },
    insertDetail: async ({ detail }) => {
      const id = state.nextDetailId++;
      state.details.push({ id, ...detail });
      events.push(["insert-detail", detail.productid]);
      return { insertId: id };
    },
    insertSnapshot: async ({ snapshot }) => {
      if (failSnapshotInsert) throw new Error("snapshot insert failed");
      const id = state.nextSnapshotId++;
      state.snapshots.push({ id, ...snapshot });
      events.push(["insert-snapshot", snapshot.product_customization_step_choice_id]);
      return { insertId: id };
    },
    updateOrder: async ({ orderId, shopId, changes }) => {
      if (state.order.id !== Number(orderId) || state.order.shopid !== Number(shopId)) {
        return { affectedRows: 0 };
      }
      Object.assign(state.order, changes);
      events.push(["update-order", { ...changes }]);
      return { affectedRows: 1 };
    },
    upsertReservation: async ({ reservation }) => {
      const existing = state.reservations.find((row) => (
        row.order_id === reservation.order_id && row.product_id === reservation.product_id
      ));
      if (existing) Object.assign(existing, reservation);
      else state.reservations.push({ id: state.reservations.length + 1, ...reservation });
      events.push(["reservation", reservation.product_id, reservation.quantity, reservation.status]);
      return { affectedRows: 1 };
    },
    insertMovement: async ({ movement }) => {
      state.movements.push({ ...movement });
      return { insertId: state.movements.length };
    },
  };
  const quoteOrderItems = async ({ shopId, items }) => {
    events.push("quote");
    assert.strictEqual(Number(shopId), 7);
    const basePrices = new Map([[10, 10], [20, 5], [30, 7]]);
    const requirements = new Map();
    const add = (id, quantity) => requirements.set(id, (requirements.get(id) || 0) + quantity);
    const resolvedItems = items.map((item) => {
      if (item.selectedChoiceIds.includes(999)) {
        throw new DomainError(
          422,
          "CUSTOMIZATION_CHOICE_NOT_ALLOWED",
          "Customization choice is not allowed",
          { product_step_choice_id: 999 },
        );
      }
      const choiceId = item.selectedChoiceIds[0];
      const choice = choiceId === 101
        ? { id: 101, extra: 1, linked: 11, name: "Cola" }
        : choiceId === 102
          ? { id: 102, extra: 2, linked: 12, name: "Jus" }
          : null;
      const unitPrice = basePrices.get(item.productId) + (choice ? choice.extra : 0);
      add(item.productId, item.quantity);
      if (choice) add(choice.linked, item.quantity);
      return {
        ...item,
        unitPrice,
        lineTotal: unitPrice * item.quantity,
        steps: choice ? [{
          product_step_id: 5,
          position: 1,
          choices: [{ product_step_choice_id: choice.id, position: 1 }],
        }] : [],
        selectedChoices: choice ? [{
          step_id: 5,
          product_step_choice_id: choice.id,
          step_name: "Boisson",
          choice_type: "linked_product",
          choice_name: choice.name,
          extra_price: choice.extra,
          linked_product_id: choice.linked,
        }] : [],
      };
    });
    const total = resolvedItems.reduce((sum, item) => sum + item.lineTotal, 0);
    return {
      resolvedItems,
      total,
      requirements,
      serverQuote: {
        total,
        items: resolvedItems.map((item) => ({
          product_id: item.productId,
          quantity: item.quantity,
          selected_choice_ids: item.selectedChoiceIds,
          unit_price: item.unitPrice,
          total: item.lineTotal,
        })),
      },
    };
  };
  const editing = buildOrderEditingModule({
    repository,
    withTransaction,
    quoteOrderItems,
    now: () => new Date("2026-07-25T10:00:00.000Z"),
  });
  const revision = () => buildContentRevision(state.order, state.details.map((detail) => ({
    ...detail,
    selections: state.snapshots
      .filter((snapshot) => snapshot.orderdetail_id === detail.id)
      .map((snapshot) => ({
        product_customization_step_choice_id:
          snapshot.product_customization_step_choice_id,
      })),
  })));
  const amend = (overrides = {}) => editing.amendOrder({
    orderId: 42,
    shopId: 7,
    operatorId: 9,
    contentRevision: revision(),
    expectedTotal: 43,
    items: [
      { productId: 10, quantity: 3, selectedChoiceIds: [102] },
      { productId: 30, quantity: 1, selectedChoiceIds: [] },
    ],
    ...overrides,
  });
  return {
    amend,
    editing,
    events,
    getState: () => state,
    revision,
  };
};

const runAmendOrderContracts = async () => {
  let harness = makeAmendHarness();
  const result = await harness.amend();
  assert.strictEqual(result.order_id, 42);
  assert.strictEqual(result.total, 43);
  assert.strictEqual(result.canceled, false);
  assert.strictEqual(harness.getState().order.status, 1);
  assert.strictEqual(harness.getState().order.subtotal, 43);
  assert.deepStrictEqual(
    harness.getState().details.map((row) => [row.productid, row.qty, row.price, row.total]),
    [[10, 3, 12, 36], [30, 1, 7, 7]],
    "adding/removing products and changing quantity replaces the stored details",
  );
  assert.deepStrictEqual(
    harness.getState().snapshots.map((row) => row.product_customization_step_choice_id),
    [102],
    "replacing a customization choice replaces its immutable snapshot",
  );
  assert.deepStrictEqual(
    [...harness.getState().products],
    [[10, 4], [11, 3], [12, 2], [20, 5], [30, 4]],
    "parent and linked stock deltas are consumed or restored",
  );
  assert.deepStrictEqual(
    harness.getState().reservations.map((row) => [row.product_id, row.quantity]),
    [[10, 3], [11, 0], [20, 0], [12, 3], [30, 1]],
  );
  const lockProducts = harness.events.find((event) => Array.isArray(event)
    && event[0] === "lock-products");
  assert.deepStrictEqual(lockProducts, ["lock-products", 7, [10, 11, 12, 20, 30]]);
  assert.ok(harness.events.indexOf("lock-order") < harness.events.indexOf("lock-details"));
  assert.ok(harness.events.indexOf("lock-details") < harness.events.indexOf("lock-reservations"));
  assert.ok(harness.events.indexOf("lock-reservations") < harness.events.indexOf(lockProducts));
  assert.ok(harness.events.indexOf(lockProducts) < harness.events.indexOf("delete-details"));

  harness = makeAmendHarness();
  await assert.rejects(
    () => harness.amend({ contentRevision: "stale" }),
    (error) => error.code === "ORDER_EDIT_CONFLICT"
      && error.content_revision === harness.revision(),
  );
  assert.ok(!harness.events.includes("quote"));

  harness = makeAmendHarness();
  await assert.rejects(
    () => harness.amend({ expectedTotal: 42 }),
    (error) => error.code === "ORDER_REPRICE_REQUIRED"
      && error.server_quote.total === 43,
  );
  assert.ok(!harness.events.some((event) => Array.isArray(event) && event[0] === "stock"));

  harness = makeAmendHarness({ product12Stock: 2 });
  const beforeShortage = cloneAmendState(harness.getState());
  await assert.rejects(
    () => harness.amend(),
    (error) => error.code === "INSUFFICIENT_STOCK"
      && error.shortages[0].product_id === 12
      && error.shortages[0].requested === 3
      && error.shortages[0].available === 2,
  );
  assert.deepStrictEqual(harness.getState(), beforeShortage);

  harness = makeAmendHarness({ failSnapshotInsert: true });
  const beforeFailure = cloneAmendState(harness.getState());
  await assert.rejects(() => harness.amend(), /snapshot insert failed/);
  assert.deepStrictEqual(harness.getState(), beforeFailure, "all writes roll back together");

  harness = makeAmendHarness();
  await assert.rejects(
    () => harness.amend({
      expectedTotal: 10,
      items: [{ productId: 10, quantity: 1, selectedChoiceIds: [999] }],
    }),
    (error) => error.code === "ORDER_RECONFIGURATION_REQUIRED"
      && error.product_step_choice_id === 999,
  );

  harness = makeAmendHarness({ product11Stock: 5, reservationsReleased: true });
  await harness.amend({
    expectedTotal: 27,
    items: [
      { productId: 10, quantity: 2, selectedChoiceIds: [101] },
      { productId: 20, quantity: 1, selectedChoiceIds: [] },
    ],
  });
  assert.deepStrictEqual([...harness.getState().products], [
    [10, 3], [11, 3], [12, 5], [20, 3], [30, 5],
  ], "released reservations cause the full edited requirements to be reserved again");
};

const runEmptyCartCancellationContract = async () => {
  let harness = makeAmendHarness();
  const result = await harness.amend({ expectedTotal: 0, items: [] });
  assert.deepStrictEqual(result, {
    order_id: 42,
    total: 0,
    canceled: true,
    content_revision: result.content_revision,
  });
  assert.match(result.content_revision, /^[a-f0-9]{64}$/);
  assert.strictEqual(harness.getState().order.status, 4);
  assert.strictEqual(harness.getState().order.subtotal, 0);
  assert.strictEqual(harness.getState().details.length, 0);
  assert.strictEqual(harness.getState().snapshots.length, 0);
  assert.strictEqual(harness.getState().legacyCustomizations.length, 0);
  assert.deepStrictEqual([...harness.getState().products], [
    [10, 7], [11, 3], [12, 5], [20, 5], [30, 5],
  ]);
  assert.ok(harness.getState().reservations.every((row) => (
    row.quantity === 0 && row.status === "released"
  )));
  assert.ok(!harness.events.includes("quote"), "cancellation does not need a new quote");
  assert.ok(harness.events.includes("commit"));

  harness = makeAmendHarness({ reservationsReleased: true });
  const stockBefore = [...harness.getState().products];
  await harness.amend({ expectedTotal: 0, items: [] });
  assert.deepStrictEqual([...harness.getState().products], stockBefore);
  assert.strictEqual(harness.getState().movements.length, 0);
  assert.ok(harness.getState().reservations.every((row) => (
    row.quantity === 0 && row.status === "released"
  )));
};

const runLegacyRevisionSymmetryContract = async () => {
  let harness = makeAmendHarness({ legacy: true });
  let editable = await harness.editing.getEditableOrder({ orderId: 42, shopId: 7 });
  assert.strictEqual(editable.items[1].requires_reconfiguration, true);
  assert.strictEqual(
    editable.items[1].selections[0].product_customization_step_choice_id,
    null,
  );
  await assert.rejects(
    () => harness.editing.amendOrder({
      orderId: 42,
      shopId: 7,
      operatorId: 9,
      contentRevision: editable.content_revision,
      expectedTotal: 10,
      items: [{ productId: 10, quantity: 1, selectedChoiceIds: [999] }],
    }),
    (error) => error.code === "ORDER_RECONFIGURATION_REQUIRED",
    "the GET revision must pass before legacy reconfiguration validation",
  );

  harness = makeAmendHarness({ legacy: true });
  editable = await harness.editing.getEditableOrder({ orderId: 42, shopId: 7 });
  const canceled = await harness.editing.amendOrder({
    orderId: 42,
    shopId: 7,
    operatorId: 9,
    contentRevision: editable.content_revision,
    expectedTotal: 0,
    items: [],
  });
  assert.strictEqual(canceled.canceled, true);
  assert.strictEqual(harness.getState().order.status, 4);
  assert.strictEqual(harness.getState().legacyCustomizations.length, 0);
};

const runAmendControllerContracts = async () => {
  const calls = [];
  const controller = buildAmendOrderController({
    amendOrder: async (input) => {
      calls.push(input);
      return { order_id: 42, total: 10, canceled: false };
    },
    logger: { error: () => {} },
  });
  let response = makeResponse();
  await controller({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: {
      content_revision: "revision",
      expected_total: 10,
      items: [{
        product_id: "10",
        quantity: 1,
        selected_product_step_choice_ids: [101],
      }],
    },
  }, response);
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(calls[0], {
    orderId: 42,
    shopId: 7,
    operatorId: 9,
    contentRevision: "revision",
    expectedTotal: 10,
    items: [{ productId: 10, quantity: 1, selectedChoiceIds: [101] }],
  });

  for (const body of [{
    content_revision: "revision", expected_total: 10, items: [], status: 4,
  }, {
    content_revision: "revision",
    expected_total: 10,
    items: [{ product_id: 10, quantity: 1, price: 0 }],
  }, {
    content_revision: "revision",
    expected_total: 10,
    items: [{
      product_id: 10,
      quantity: 1,
      selected_product_step_choice_ids: "101",
    }],
  }]) {
    response = makeResponse();
    await controller({ params: { id: "42" }, shopid: 7, id: 9, body }, response);
    assert.strictEqual(response.statusCode, 400);
    assert.strictEqual(response.payload.data.code, "ORDER_EDIT_REQUEST_INVALID");
  }
  assert.strictEqual(calls.length, 1, "forbidden fields never reach the module");

  const errorController = buildAmendOrderController({
    amendOrder: async () => {
      throw new DomainError(409, "INSUFFICIENT_STOCK", "Stock insuffisant.", {
        shortages: [{ product_id: 12, requested: 3, available: 2 }],
      });
    },
    logger: { error: () => {} },
  });
  response = makeResponse();
  await errorController({
    params: { id: "42" }, shopid: 7, id: 9, body: { content_revision: "x", expected_total: 0, items: [] },
  }, response);
  assert.strictEqual(response.statusCode, 409);
  assert.deepStrictEqual(response.payload.data, {
    code: "INSUFFICIENT_STOCK",
    shortages: [{ product_id: 12, requested: 3, available: 2 }],
  });
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const runPreparationEditRaceContract = async () => {
  const state = {
    order: {
      id: 42,
      shopid: 7,
      status: ORDER_STATUSES.PENDING,
      payment_status: "unpaid",
    },
  };
  let lockTail = Promise.resolve();
  let lockCount = 0;
  const runInTransaction = async (work) => {
    const connection = {};
    try {
      return await work(connection);
    } finally {
      if (connection.releaseOrder) connection.releaseOrder();
    }
  };
  const lockOrder = async ({ connection }) => {
    const previous = lockTail;
    let release;
    lockTail = new Promise((done) => { release = done; });
    await previous;
    lockCount += 1;
    connection.releaseOrder = release;
    return state.order;
  };
  const transitionEntered = deferred();
  const finishTransition = deferred();
  const transitions = buildOrderTransitionModule({
    withTransaction: runInTransaction,
    repository: {
      lockOrder,
      updateStatus: async ({ nextStatus }) => {
        transitionEntered.resolve();
        await finishTransition.promise;
        state.order.status = nextStatus;
        return { affectedRows: 1 };
      },
    },
  });
  const editing = buildOrderEditingModule({
    withTransaction: runInTransaction,
    repository: { lockOrder },
  });

  const preparation = transitions.transitionOrderStatus({
    orderId: 42,
    shopId: 7,
    operator: 9,
    nextStatus: ORDER_STATUSES.PREPARING,
  });
  await transitionEntered.promise;
  assert.strictEqual(lockCount, 1, "preparation owns the order lock before updating status");
  const amendment = editing.amendOrder({
    orderId: 42,
    shopId: 7,
    operatorId: 9,
    contentRevision: "stale-revision",
    expectedTotal: 0,
    items: [],
  });
  finishTransition.resolve();

  await preparation;
  await assert.rejects(
    amendment,
    (error) => error.code === "ORDER_NOT_EDITABLE",
    "the edit must re-read PREPARING after waiting for the transition lock",
  );
  assert.strictEqual(state.order.status, ORDER_STATUSES.PREPARING);
};

const runTransitionValidationContract = async () => {
  let updates = 0;
  const transitions = buildOrderTransitionModule({
    withTransaction: async (work) => work({ transaction: true }),
    repository: {
      lockOrder: async () => ({
        id: 42,
        shopid: 7,
        status: ORDER_STATUSES.PENDING,
      }),
      updateStatus: async () => {
        updates += 1;
        return { affectedRows: 1 };
      },
    },
  });
  await assert.rejects(
    () => transitions.transitionOrderStatus({
      orderId: 42,
      shopId: 7,
      operator: 9,
      nextStatus: ORDER_STATUSES.FINISHED,
    }),
    (error) => error.code === "ORDER_STATUS_TRANSITION_INVALID" && error.status === 422,
  );
  assert.strictEqual(updates, 0, "an invalid transition must not update the order");
};

const runStatusControllerContract = async () => {
  let received;
  const controller = buildUpdateOrderController({
    transitionOrderStatus: async (input) => {
      received = input;
      return { result: { affectedRows: 1 } };
    },
  });
  const response = makeResponse();
  await controller({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: { operator: 999, status: ORDER_STATUSES.PREPARING, subtotal: 999 },
  }, response);
  assert.deepStrictEqual(received, {
    orderId: 42,
    shopId: 7,
    operator: 9,
    nextStatus: ORDER_STATUSES.PREPARING,
  });
  assert.strictEqual(response.statusCode, 200);
};

const runForbiddenCancellationControllerContract = async () => {
  let stripeCancellationCalls = 0;
  let transactions = 0;
  const transitions = buildOrderTransitionModule({
    withTransaction: async (work) => {
      transactions += 1;
      return work({ transaction: true });
    },
    repository: {
      lockOrder: async () => ({
        id: 42,
        shopid: 7,
        status: ORDER_STATUSES.FINISHED,
        payment_status: "requires_payment",
        payment_provider: "stripe",
        stripe_payment_intent_id: "pi_42",
      }),
      updateStatus: async () => ({ affectedRows: 1 }),
    },
  });
  const controller = buildUpdateOrderController({
    transitionOrderStatus: transitions.transitionOrderStatus,
    cancelPendingStripePayment: async () => {
      stripeCancellationCalls += 1;
    },
  });
  const response = makeResponse();

  await controller({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: { status: ORDER_STATUSES.CANCELED },
  }, response);

  assert.strictEqual(response.statusCode, 422);
  assert.strictEqual(response.payload.data.code, "ORDER_STATUS_TRANSITION_INVALID");
  assert.strictEqual(transactions, 1, "the locked order is validated exactly once");
  assert.strictEqual(
    stripeCancellationCalls,
    0,
    "Stripe is untouched when the locked order cannot transition to CANCELED",
  );
};

const runAllowedCancellationControllerContract = async () => {
  const events = [];
  const connection = { transaction: true };
  let transactionActive = false;
  const lockedOrder = {
    id: 42,
    shopid: 7,
    status: ORDER_STATUSES.PENDING,
    payment_status: "requires_payment",
    payment_provider: "stripe",
    stripe_payment_intent_id: "pi_42",
  };
  const transitions = buildOrderTransitionModule({
    withTransaction: async (work) => {
      transactionActive = true;
      try {
        return await work(connection);
      } finally {
        transactionActive = false;
      }
    },
    repository: {
      lockOrder: async () => {
        events.push("lock-order");
        return lockedOrder;
      },
      updateStatus: async () => {
        events.push("update-status");
        return { affectedRows: 1 };
      },
    },
  });
  const controller = buildUpdateOrderController({
    transitionOrderStatus: transitions.transitionOrderStatus,
    cancelPendingStripePayment: async (order) => {
      assert.strictEqual(order, lockedOrder);
      assert.strictEqual(transactionActive, true, "Stripe runs while the order lock is held");
      events.push("cancel-stripe");
      return "pi_42";
    },
    markPaymentCanceled: async (paymentIntentId, options = {}) => {
      assert.strictEqual(paymentIntentId, "pi_42");
      assert.strictEqual(options.connection, connection);
      assert.strictEqual(options.order, lockedOrder);
      events.push("cancel-local-payment");
    },
  });

  await controller({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: { status: ORDER_STATUSES.CANCELED },
  }, makeResponse());

  assert.deepStrictEqual(events, [
    "lock-order",
    "cancel-stripe",
    "cancel-local-payment",
    "update-status",
  ]);
};

const runCancellationRaceContract = async () => {
  const order = {
    id: 42,
    shopid: 7,
    status: ORDER_STATUSES.PREPARING,
    payment_status: "requires_payment",
    payment_provider: "stripe",
    stripe_payment_intent_id: "pi_42",
  };
  let lockTail = Promise.resolve();
  let concurrentStarted = false;
  const concurrentLockAttempted = deferred();
  const runInTransaction = async (work) => {
    const connection = {};
    try {
      return await work(connection);
    } finally {
      if (connection.releaseOrder) connection.releaseOrder();
    }
  };
  const lockOrder = async ({ connection }) => {
    const previous = lockTail;
    let release;
    lockTail = new Promise((done) => { release = done; });
    if (concurrentStarted) concurrentLockAttempted.resolve();
    await previous;
    connection.releaseOrder = release;
    return order;
  };
  const stripeEntered = deferred();
  const finishStripe = deferred();
  const transitions = buildOrderTransitionModule({
    withTransaction: runInTransaction,
    repository: {
      lockOrder,
      updateStatus: async ({ nextStatus }) => {
        order.status = nextStatus;
        return { affectedRows: 1 };
      },
    },
  });
  const controller = buildUpdateOrderController({
    transitionOrderStatus: transitions.transitionOrderStatus,
    cancelPendingStripePayment: async () => {
      stripeEntered.resolve();
      await finishStripe.promise;
      return "pi_42";
    },
    markPaymentCanceled: async () => ({ status: "canceled" }),
  });

  const cancellationResponse = makeResponse();
  const cancellation = controller({
    params: { id: "42" },
    shopid: 7,
    id: 9,
    body: { status: ORDER_STATUSES.CANCELED },
  }, cancellationResponse);
  await stripeEntered.promise;

  concurrentStarted = true;
  let finishingSettled = false;
  const finishing = transitions.transitionOrderStatus({
    orderId: 42,
    shopId: 7,
    operator: 9,
    nextStatus: ORDER_STATUSES.FINISHED,
  }).then(
    (value) => {
      finishingSettled = true;
      return { value };
    },
    (error) => {
      finishingSettled = true;
      return { error };
    },
  );
  await concurrentLockAttempted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(finishingSettled, false, "FINISHED waits for Stripe cancellation");
  assert.strictEqual(order.status, ORDER_STATUSES.PREPARING);

  finishStripe.resolve();
  await cancellation;
  const finishingOutcome = await finishing;
  assert.strictEqual(cancellationResponse.statusCode, 200);
  assert.strictEqual(order.status, ORDER_STATUSES.CANCELED);
  assert.strictEqual(finishingOutcome.error.code, "ORDER_STATUS_TRANSITION_INVALID");
};

runEligibilityContracts();
runRevisionContracts();
runEditableReadContracts()
  .then(runControllerContracts)
  .then(runAmendOrderContracts)
  .then(runEmptyCartCancellationContract)
  .then(runLegacyRevisionSymmetryContract)
  .then(runAmendControllerContracts)
  .then(runPreparationEditRaceContract)
  .then(runTransitionValidationContract)
  .then(runStatusControllerContract)
  .then(runAllowedCancellationControllerContract)
  .then(runCancellationRaceContract)
  .then(runForbiddenCancellationControllerContract)
  .then(runRouterContract)
  .then(() => console.log("order editing tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
