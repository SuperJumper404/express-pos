const { parseMoney } = require("./money");
const { normalizePaymentMethod } = require("./paymentMethod");

const moneyOrZero = (value) => {
  const parsed = parseMoney(value);
  return parsed === null ? 0 : parsed;
};

const parseMetricDate = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const normalized = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
};

const addDays = (date, amount) => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + amount);
  return next.toISOString().slice(0, 10);
};

const buildDateRange = (from, to) => {
  const start = parseMetricDate(from);
  const end = parseMetricDate(to) || start;
  if (!start || !end) return [];

  const dates = [];
  for (let date = start; date <= end; date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
};

const buildRevenueByDayAndPayment = (orders, from, to) => {
  const rows = new Map(
    buildDateRange(from, to).map((date) => [
      date,
      {
        date,
        total: 0,
        payments: {},
      },
    ]),
  );

  for (const order of Array.isArray(orders) ? orders : []) {
    const date = parseMetricDate(order.created || order.archived_at);
    if (!date || !rows.has(date)) continue;

    const method = normalizePaymentMethod(order.payment, order.payment_provider);
    if (!method) continue;

    const amount = moneyOrZero(order.subtotal);
    const row = rows.get(date);
    row.payments[method] = Number(
      ((row.payments[method] || 0) + amount).toFixed(2),
    );
    row.total = Number((row.total + amount).toFixed(2));
  }

  return Array.from(rows.values());
};

module.exports = {
  buildRevenueByDayAndPayment,
  buildDeliverySalesSummary,
};

// Sale documents remain gross and immutable; refund status is a separate axis.
function buildDeliverySalesSummary(orders) {
  let deliveryFees = 0;
  let refundedSales = 0;
  const rates = new Map();
  const addVat = (rate, ht, tax, ttc) => {
    if ([rate, ht, tax, ttc].some(value => value == null || !Number.isFinite(Number(value)))) return;
    const key = Number(rate);
    const row = rates.get(key) || { vat_rate: key, total_ht: 0, total_vat: 0, total_ttc: 0 };
    row.total_ht += Math.round(Number(ht) * 100);
    row.total_vat += Math.round(Number(tax) * 100);
    row.total_ttc += Math.round(Number(ttc) * 100);
    rates.set(key, row);
  };
  const seenDeliveries = new Set();
  for (const order of orders || []) {
    if (order.payment_status === 'refunded') refundedSales += Math.round(moneyOrZero(order.subtotal) * 100);
    for (const item of order.details || []) addVat(item.vat_rate, item.total_ht, item.total_vat, item.total);
    const charge = order.financials?.delivery_charge || order.delivery_charge;
    const identity = `${order.shopid}:${order.delivery_id}`;
    if (!charge || seenDeliveries.has(identity)) continue;
    seenDeliveries.add(identity);
    deliveryFees += charge.feeCents;
    if (charge.feeCents > 0) addVat(charge.vatRate, charge.totalExclTaxCents / 100, charge.taxCents / 100, charge.feeCents / 100);
  }
  return { deliveryFees: deliveryFees / 100, refundedSales: refundedSales / 100,
    vatSummary: [...rates.values()].sort((a, b) => a.vat_rate - b.vat_rate).map(row => ({
      vat_rate: row.vat_rate, total_ht: row.total_ht / 100, total_vat: row.total_vat / 100, total_ttc: row.total_ttc / 100,
    })) };
}
