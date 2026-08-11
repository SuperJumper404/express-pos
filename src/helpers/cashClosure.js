const moneyOrZero = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const roundMoney = (value) => Number(moneyOrZero(value).toFixed(2));

const isoOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const getOrderCreatedIso = (order) => isoOrNull(order && order.created);

const getClosurePeriodBounds = ({ lastClosure, archivedOrders = [], now }) => {
  const closedAt = isoOrNull(now) || new Date().toISOString();
  const previousClosedAt = isoOrNull(lastClosure && lastClosure.closed_at);
  if (previousClosedAt) {
    return { opened_at: previousClosedAt, closed_at: closedAt };
  }

  const firstArchivedOrderDate = archivedOrders
    .map(getOrderCreatedIso)
    .filter(Boolean)
    .sort()[0] || null;

  return { opened_at: firstArchivedOrderDate, closed_at: closedAt };
};

const buildPaymentSummary = (orders = []) => {
  const totals = new Map();

  orders.forEach((order) => {
    const payment = String((order && order.payment) || "").trim() || "Autres";
    const current = totals.get(payment) || { payment, orders_count: 0, total: 0 };
    current.orders_count += 1;
    current.total = roundMoney(current.total + moneyOrZero(order && order.subtotal));
    totals.set(payment, current);
  });

  return Array.from(totals.values());
};

const normalizeVatRate = (value) => {
  if (value === undefined || value === null || value === "") return "Non renseignee";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "Non renseignee";
  return numeric.toFixed(2);
};

const buildVatSummary = (detailRows = []) => {
  const totals = new Map();

  detailRows.forEach((row) => {
    const vatRate = normalizeVatRate(row && row.vat_rate);
    const current = totals.get(vatRate) || {
      vat_rate: vatRate,
      total_ht: 0,
      total_vat: 0,
      total_ttc: 0,
    };
    current.total_ht = roundMoney(current.total_ht + moneyOrZero(row && row.total_ht));
    current.total_vat = roundMoney(current.total_vat + moneyOrZero(row && row.total_vat));
    current.total_ttc = roundMoney(current.total_ttc + moneyOrZero(row && row.total));
    totals.set(vatRate, current);
  });

  return Array.from(totals.values());
};

const buildCashClosureSnapshot = ({
  lastClosure,
  archivedOrders = [],
  detailRows = [],
  now,
}) => {
  const bounds = getClosurePeriodBounds({ lastClosure, archivedOrders, now });

  return {
    ...bounds,
    orders_count: archivedOrders.length,
    total_revenue: roundMoney(
      archivedOrders.reduce(
        (total, order) => total + moneyOrZero(order && order.subtotal),
        0
      )
    ),
    payments_summary: buildPaymentSummary(archivedOrders),
    vat_summary: buildVatSummary(detailRows),
  };
};

module.exports = {
  buildCashClosureSnapshot,
  buildPaymentSummary,
  buildVatSummary,
  getClosurePeriodBounds,
};
