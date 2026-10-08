const assert = require("assert");

const {
  buildRevenueByDayAndPayment,
} = require("../src/helpers/orderMetrics");

const series = buildRevenueByDayAndPayment(
  [
    {
      id: 1,
      created: "2026-10-01 09:12:00",
      subtotal: "7.50",
      payment: "Espèces",
    },
    {
      id: 2,
      created: "2026-10-01 14:30:00",
      subtotal: "5.00",
      payment: "Carte bancaire",
      payment_provider: "stripe",
    },
    {
      id: 3,
      created: "2026-10-03 18:45:00",
      subtotal: "15.00",
      payment: "stripe_terminal",
      payment_provider: "stripe_terminal",
    },
  ],
  "2026-10-01",
  "2026-10-03",
);

assert.deepStrictEqual(series, [
  {
    date: "2026-10-01",
    total: 12.5,
    payments: {
      "Espèces": 7.5,
      Stripe: 5,
    },
  },
  {
    date: "2026-10-02",
    total: 0,
    payments: {},
  },
  {
    date: "2026-10-03",
    total: 15,
    payments: {
      "TPE Stripe": 15,
    },
  },
]);

const packageJson = require("../package.json");
assert.ok(
  packageJson.scripts.test.includes("test/order-metrics-revenue-series.test.js"),
  "backend npm test must include the order metrics revenue series contract",
);

console.log("order metrics revenue series tests passed");
