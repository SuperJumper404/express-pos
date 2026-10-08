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
};
