const assert = require("assert");
const {
  buildCashClosureSnapshot,
  buildPaymentSummary,
  buildVatSummary,
  getClosurePeriodBounds,
} = require("../src/helpers/cashClosure");

const orders = [
  { id: 10, created: "2026-08-11T09:00:00.000Z", subtotal: "12.50", payment: "Carte" },
  { id: 11, created: "2026-08-11T10:00:00.000Z", subtotal: 7.5, payment: "Especes" },
  { id: 12, created: "2026-08-11T11:00:00.000Z", subtotal: null, payment: "" },
];

assert.deepStrictEqual(
  getClosurePeriodBounds({
    lastClosure: { closed_at: "2026-08-10T23:00:00.000Z" },
    archivedOrders: orders,
    now: "2026-08-11T12:00:00.000Z",
  }),
  {
    opened_at: "2026-08-10T23:00:00.000Z",
    closed_at: "2026-08-11T12:00:00.000Z",
  }
);

assert.deepStrictEqual(
  getClosurePeriodBounds({
    lastClosure: null,
    archivedOrders: orders,
    now: "2026-08-11T12:00:00.000Z",
  }),
  {
    opened_at: "2026-08-11T09:00:00.000Z",
    closed_at: "2026-08-11T12:00:00.000Z",
  }
);

assert.deepStrictEqual(buildPaymentSummary(orders), [
  { payment: "Carte", orders_count: 1, total: 12.5 },
  { payment: "Especes", orders_count: 1, total: 7.5 },
  { payment: "Autres", orders_count: 1, total: 0 },
]);

assert.deepStrictEqual(
  buildVatSummary([
    { vat_rate: "10.00", total_ht: "10.00", total_vat: "1.00", total: "11.00" },
    { vat_rate: 10, total_ht: "5.00", total_vat: "0.50", total: "5.50" },
    { vat_rate: null, total_ht: null, total_vat: null, total: "4.00" },
  ]),
  [
    { vat_rate: "10.00", total_ht: 15, total_vat: 1.5, total_ttc: 16.5 },
    { vat_rate: "Non renseignee", total_ht: 0, total_vat: 0, total_ttc: 4 },
  ]
);

assert.deepStrictEqual(
  buildCashClosureSnapshot({
    lastClosure: { closed_at: "2026-08-10T23:00:00.000Z" },
    archivedOrders: orders,
    detailRows: [{ vat_rate: "20.00", total_ht: "10.00", total_vat: "2.00", total: "12.00" }],
    now: "2026-08-11T12:00:00.000Z",
  }),
  {
    opened_at: "2026-08-10T23:00:00.000Z",
    closed_at: "2026-08-11T12:00:00.000Z",
    orders_count: 3,
    total_revenue: 20,
    payments_summary: [
      { payment: "Carte", orders_count: 1, total: 12.5 },
      { payment: "Especes", orders_count: 1, total: 7.5 },
      { payment: "Autres", orders_count: 1, total: 0 },
    ],
    vat_summary: [{ vat_rate: "20.00", total_ht: 10, total_vat: 2, total_ttc: 12 }],
  }
);

assert.deepStrictEqual(
  buildCashClosureSnapshot({
    lastClosure: null,
    archivedOrders: [],
    detailRows: [],
    now: "2026-08-11T12:00:00.000Z",
  }),
  {
    opened_at: null,
    closed_at: "2026-08-11T12:00:00.000Z",
    orders_count: 0,
    total_revenue: 0,
    payments_summary: [],
    vat_summary: [],
  }
);

const fs = require("fs");
const path = require("path");

const migration = fs.readFileSync(
  path.join(__dirname, "../db/migrations/20260811170000_cash_closures.sql"),
  "utf8"
);
assert.ok(migration.includes("CREATE TABLE IF NOT EXISTS `cash_closures`"));
assert.ok(migration.includes("`closure_number` INT NOT NULL"));
assert.ok(migration.includes("`payments_summary` JSON NOT NULL"));
assert.ok(migration.includes("`vat_summary` JSON NOT NULL"));

const moduleSource = fs.readFileSync(
  path.join(__dirname, "../src/modules/m_cashClosures.js"),
  "utf8"
);
assert.ok(moduleSource.includes("mGetCurrentCashClosure"));
assert.ok(moduleSource.includes("mCloseCurrentCashClosure"));
assert.ok(moduleSource.includes("FOR UPDATE"));
assert.ok(moduleSource.includes("orders_count <= 0"));
assert.ok(moduleSource.includes("La periode ne contient aucune commande a cloturer."));
assert.ok(moduleSource.includes("JSON.stringify(snapshot.payments_summary)"));
assert.ok(moduleSource.includes("JSON.stringify(snapshot.vat_summary)"));

const controllerSource = fs.readFileSync(
  path.join(__dirname, "../src/controllers/c_cashClosures.js"),
  "utf8"
);
assert.ok(controllerSource.includes("currentCashClosure"));
assert.ok(controllerSource.includes("closeCashClosure"));
assert.ok(controllerSource.includes("allCashClosures"));
assert.ok(controllerSource.includes("cashClosureById"));

const routerSource = fs.readFileSync(
  path.join(__dirname, "../src/routers/r_orders.js"),
  "utf8"
);
assert.ok(routerSource.includes('require("../controllers/c_cashClosures")'));
assert.ok(routerSource.includes('"/reports/z/current"'));
assert.ok(routerSource.includes('"/reports/z/close"'));
assert.ok(routerSource.includes('"/reports/z"'));
assert.ok(routerSource.includes('"/reports/z/:id"'));

console.log("cash closure helper tests passed");
