const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { normalizePaymentMethod } = require('../src/helpers/paymentMethod');
const { buildRevenueByDayAndPayment, buildDeliverySalesSummary } = require('../src/helpers/orderMetrics');
const { standalonePaymentSummary, standaloneReportEntries } = require('../src/modules/m_terminalReports');
const source = fs.readFileSync(require.resolve('../src/controllers/c_orders'), 'utf8');

async function metrics(orders, standalone) {
  const context = { exports: {}, console, Date, moneyOrZero: value => Number(value || 0), normalizePaymentMethod,
    buildRevenueByDayAndPayment, buildDeliverySalesSummary, standalonePaymentSummary, standaloneReportEntries,
    mAllArchivedOrdersWithDetails: async () => orders,
    mGetStandaloneReportPayments: async input => { assert.equal(input.shopId, 7); return standalone; } };
  vm.runInNewContext(source.slice(source.indexOf('exports.metrics =')), context);
  let result;
  await context.exports.metrics({ shopid: 7, query: { from: '2026-11-09', to: '2026-11-10' } }, { json: value => { result = value; } });
  return JSON.parse(JSON.stringify(result.data));
}

test('mixed statistics add autonomous amounts on confirmation day and preserve real order averages', async () => {
  const result = await metrics([{ id: 1, subtotal: 20, created: '2026-11-09 12:00:00', payment: 'Espèces',
    details: [{ name: 'Menu', qty: 1, total: 20 }] }], [{ id: 81, amount_cents: 1250, confirmed_at: '2026-11-10 13:00:00' }]);
  assert.equal(result.totalRevenue, 32.5);
  assert.equal(result.totalOrders, 1);
  assert.equal(result.averageOrder, 20);
  assert.equal(result.standalonePaymentsCount, 1);
  assert.equal(result.standalonePaymentsRevenue, 12.5);
  assert.deepEqual(result.topProducts, [{ name: 'Menu', qty: 1, revenue: 20 }]);
  assert.equal(result.paymentsSummary.find(row => row.name === 'TPE Stripe').amount, 12.5);
  assert.equal(result.revenueByDayAndPayment[0].total, 20);
  assert.equal(result.revenueByDayAndPayment[1].total, 12.5);
});

test('autonomous-only statistics have zero orders, no product sales and no invented VAT', async () => {
  const result = await metrics([], [{ id: 81, amount_cents: 1, confirmed_at: '2026-11-10 13:00:00' }]);
  assert.equal(result.totalRevenue, 0.01);
  assert.equal(result.totalOrders, 0);
  assert.equal(result.averageOrder, 0);
  assert.deepEqual(result.topProducts, []);
  assert.deepEqual(result.vatSummary, []);
});
