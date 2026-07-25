const assert = require("assert");
const fs = require("fs");
const DomainError = require("../src/helpers/domainError");
const {
  buildOrderEditingModule,
  buildContentRevision,
  isOrderEditable,
} = require("../src/modules/m_orderEditing");
const {
  buildOrderEditingController,
} = require("../src/controllers/c_orderEditing");

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
};

runEligibilityContracts();
runRevisionContracts();
runEditableReadContracts()
  .then(runControllerContracts)
  .then(runRouterContract)
  .then(() => console.log("order editing tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
