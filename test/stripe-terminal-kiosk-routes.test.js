const assert = require("assert");
const fs = require("fs");
const auth = require("../src/helpers/middleware/auth");
const { buildStripeTerminalController } = require("../src/controllers/c_stripeTerminal");

const read = (request) => fs.readFileSync(require.resolve(request), "utf8");
const routerSource = read("../src/routers/r_stripe");
const controllerSource = read("../src/controllers/c_stripeTerminal");
const controllerExports = require("../src/controllers/c_stripeTerminal");

for (const [method, route, handler] of [
  ["get", "/stripe/terminal/kiosk/current-reader", "getKioskCurrentReader"],
  ["post", "/stripe/terminal/kiosk/payments", "startKioskPayment"],
  ["get", "/stripe/terminal/kiosk/payments/:id", "getKioskPaymentStatus"],
  ["post", "/stripe/terminal/kiosk/payments/:id/cancel", "cancelKioskPayment"],
]) {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(
    routerSource,
    new RegExp(`\\.${method}\\("${escaped}", authentication, stripeTerminal\\.${handler}\\)`),
    `${method.toUpperCase()} ${route} must bind authentication and the kiosk controller`,
  );
  assert.strictEqual(typeof controllerExports[handler], "function", `${handler} controller must exist`);
}

const kioskHandleBlock = controllerSource.match(/const kioskHandle[\s\S]*?return \{/);
assert.ok(kioskHandleBlock, "kiosk controller handle must exist");
assert.match(kioskHandleBlock[0], /req\.sessionSubject\s*!==\s*["']service_point["']/);

const invoke = async (handler, overrides = {}) => {
  const req = {
    shopid: 7,
    id: 11,
    access: 1,
    sessionSubject: "service_point",
    servicePointId: 4,
    orderSource: "borne",
    params: { id: "41" },
    body: {},
    ...overrides,
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };
  await handler(req, res);
  return res;
};

(async () => {
  let received;
  const controller = buildStripeTerminalController({
    kioskPaymentService: {
      getCurrentReader: async (input) => ({ input }),
      startPayment: async (input) => { received = input; return { id: 41 }; },
      getPaymentStatus: async (input) => ({ input }),
      cancelPayment: async (input) => ({ input }),
    },
  });

  const forbidden = await invoke(controller.startKioskPayment, { sessionSubject: "staff" });
  assert.strictEqual(forbidden.statusCode, 403);
  assert.strictEqual(forbidden.body.error, "TERMINAL_FORBIDDEN");

  const response = await invoke(controller.startKioskPayment, {
    body: {
      customer: { name: "Ada" },
      items: [{ product_id: 1, quantity: 1 }],
      expected_total: 20,
      client_order_token: "borne-token",
      readerId: 999,
      amountCents: 1,
    },
  });
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(received.shopId, 7);
  assert.strictEqual(received.servicePointId, 4);
  assert.deepStrictEqual(received.checkoutPayload, {
    customer: { name: "Ada" },
    items: [{ product_id: 1, quantity: 1 }],
    expected_total: 20,
    client_order_token: "borne-token",
  });
  assert(!Object.prototype.hasOwnProperty.call(received.checkoutPayload, "readerId"));
  assert(!Object.prototype.hasOwnProperty.call(received.checkoutPayload, "amountCents"));

  const cashierController = buildStripeTerminalController({
    paymentService: { startPayment: async () => ({ id: 99 }) },
  });
  const cashierRejected = await invoke(cashierController.startPayment);
  assert.strictEqual(cashierRejected.statusCode, 403);

  const paths = ["../src/controllers/c_stripe", "../src/controllers/c_orderEditing", "../src/routers/r_stripe"]
    .map(require.resolve);
  const previous = paths.map((path) => require.cache[path]);
  require.cache[paths[0]] = { exports: Object.fromEntries([
    "getConnectStatus",
    "createConnectOnboardingLink",
    "createQrTablePaymentIntent",
    "cancelQrTablePaymentIntent",
    "markQrTablePaymentAtCounter",
    "refundPaidOrder",
    "handleWebhook",
  ].map((name) => [name, () => {}])) };
  require.cache[paths[1]] = { exports: { replacementPayment: () => {} } };
  delete require.cache[paths[2]];
  try {
    const { routers } = require(paths[2]);
    for (const [verb, path] of [
      ["get", "/stripe/terminal/kiosk/current-reader"],
      ["post", "/stripe/terminal/kiosk/payments"],
      ["get", "/stripe/terminal/kiosk/payments/:id"],
      ["post", "/stripe/terminal/kiosk/payments/:id/cancel"],
    ]) {
      const layer = routers.stack.find((route) => route.route && route.route.path === path && route.route.methods[verb]);
      assert(layer, `Missing ${verb} ${path}`);
      assert.deepStrictEqual(layer.route.stack[0].handle, auth.authentication);
    }
  } finally {
    paths.forEach((path, index) => {
      if (previous[index]) require.cache[path] = previous[index];
      else delete require.cache[path];
    });
  }

  console.log("stripe terminal kiosk route contracts passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
