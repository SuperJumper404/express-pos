const assert = require("assert");
const fs = require("fs");

const read = (request) => fs.readFileSync(require.resolve(request), "utf8");
const routerSource = read("../src/routers/r_stripe");
const authSource = read("../src/helpers/middleware/auth");
const controllerSource = read("../src/controllers/c_stripeTerminal");
const paymentServiceSource = read("../src/services/stripeTerminalPayments");
const readerServiceSource = read("../src/services/stripeTerminalReaders");
const orderSource = read("../src/modules/m_orders");
const packageJson = require("../package.json");
const controller = require("../src/controllers/c_stripeTerminal");

const adminRoutes = [
  ["get", "/stripe/terminal/readers", "listReaders"],
  ["post", "/stripe/terminal/readers", "registerReader"],
  ["patch", "/stripe/terminal/readers/:id/assignment", "assignReader"],
  ["patch", "/stripe/terminal/readers/:id/status", "setReaderActive"],
  ["post", "/stripe/terminal/readers/refresh", "refreshReaders"],
];

for (const [method, route, handler] of adminRoutes) {
  const pattern = new RegExp(`\\.${method}\\("${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}", authentication, authAdmin, stripeTerminal\\.${handler}\\)`);
  assert.match(routerSource, pattern, `${method.toUpperCase()} ${route} must require admin authentication`);
  assert.strictEqual(typeof controller[handler], "function", `${handler} controller must exist`);
}

const cashierRoutes = [
  ["get", "/stripe/terminal/current-reader", "getCurrentReader"],
  ["post", "/stripe/terminal/payments", "startPayment"],
  ["get", "/stripe/terminal/payments/:id", "getPaymentStatus"],
  ["post", "/stripe/terminal/payments/:id/cancel", "cancelPayment"],
];

for (const [method, route, handler] of cashierRoutes) {
  const pattern = new RegExp(`\\.${method}\\("${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}", authentication, authorizeCashRegister, stripeTerminal\\.${handler}\\)`);
  assert.match(routerSource, pattern, `${method.toUpperCase()} ${route} must require cash-register authorization`);
  assert.strictEqual(typeof controller[handler], "function", `${handler} controller must exist`);
}

assert.match(authSource, /authorizeCashRegister\s*=\s*buildModuleAuthorization\(\{\s*moduleKey:\s*["']cashregister["']/);
const startPaymentBlock = controllerSource.match(
  /startPayment:\s*handle\("startPayment",[\s\S]*?\},\s*\{ admin: false, payment: true \}\)/
);
assert.ok(startPaymentBlock, "startPayment controller mapping must exist");
assert.match(startPaymentBlock[0], /const body = req\.body \|\| \{\}/);
assert.match(startPaymentBlock[0], /orderIds:\s*body\.orderIds/);
assert.match(startPaymentBlock[0], /discountType:\s*body\.discountType/);
assert.match(startPaymentBlock[0], /discountValue:\s*body\.discountValue/);
assert.doesNotMatch(startPaymentBlock[0], /readerId/);
assert.doesNotMatch(startPaymentBlock[0], /amount(?:Cents)?/);

for (const code of [
  "TERMINAL_INVALID_INPUT",
  "TERMINAL_INVALID_ORDERS",
  "TERMINAL_NO_READER",
  "TERMINAL_READER_OFFLINE",
  "TERMINAL_READER_BUSY",
  "TERMINAL_RECOVERY_REQUIRED",
  "TERMINAL_PAYMENT_NOT_FOUND",
]) assert.ok(paymentServiceSource.includes(code), `${code} must remain stable`);
assert.ok(
  readerServiceSource.includes("TERMINAL_FORBIDDEN") && controllerSource.includes("TERMINAL_FORBIDDEN"),
  "TERMINAL_FORBIDDEN must remain stable"
);

assert.match(orderSource, /payment_provider\s*=\s*['"]stripe_terminal['"]/);
assert.match(orderSource, /stripe_terminal_payment_id/);
assert.ok(packageJson.scripts.test.includes("node test/stripe-terminal-routes.test.js"), "backend npm test must include the Terminal route contract");

console.log("stripe terminal route contracts passed");
