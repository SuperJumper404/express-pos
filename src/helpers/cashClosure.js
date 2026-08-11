const moneyOrZero = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const roundMoney = (value) => Number(moneyOrZero(value).toFixed(2));

const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z)?$/;

const timestampOrNull = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    const timestamp = value.trim();
    if (TIMESTAMP_PATTERN.test(timestamp)) return timestamp;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const timestampSortKey = (value) => {
  const timestamp = timestampOrNull(value);
  const match = timestamp && timestamp.match(TIMESTAMP_PATTERN);
  if (!match) return null;
  const fraction = (match[7] || "").padEnd(6, "0");
  return `${match.slice(1, 7).join("")}${fraction}`;
};

const getOrderArchivedTimestamp = (order) => timestampOrNull(
  order && (order.archived_at || order.created)
);

const filterArchivedOrdersForPeriod = ({
  lastClosure,
  archivedOrders = [],
  now,
}) => {
  const openedAt = timestampOrNull(lastClosure && lastClosure.closed_at);
  const closedAt = timestampOrNull(now) || new Date().toISOString();
  const openedAtKey = timestampSortKey(openedAt);
  const closedAtKey = timestampSortKey(closedAt);

  return archivedOrders.filter((order) => {
    const archivedAtKey = timestampSortKey(getOrderArchivedTimestamp(order));
    if (!archivedAtKey || archivedAtKey > closedAtKey) return false;
    return !openedAtKey || archivedAtKey > openedAtKey;
  });
};

const getClosurePeriodBounds = ({ lastClosure, archivedOrders = [], now }) => {
  const closedAt = timestampOrNull(now) || new Date().toISOString();
  const previousClosedAt = timestampOrNull(lastClosure && lastClosure.closed_at);
  if (previousClosedAt) {
    return { opened_at: previousClosedAt, closed_at: closedAt };
  }

  const firstArchivedOrderDate = archivedOrders
    .map(getOrderArchivedTimestamp)
    .filter(Boolean)
    .sort((left, right) => (
      timestampSortKey(left).localeCompare(timestampSortKey(right))
    ))[0] || null;

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
  const periodOrders = filterArchivedOrdersForPeriod({
    lastClosure,
    archivedOrders,
    now,
  });
  const bounds = getClosurePeriodBounds({
    lastClosure,
    archivedOrders: periodOrders,
    now,
  });

  return {
    ...bounds,
    orders_count: periodOrders.length,
    total_revenue: roundMoney(
      periodOrders.reduce(
        (total, order) => total + moneyOrZero(order && order.subtotal),
        0
      )
    ),
    payments_summary: buildPaymentSummary(periodOrders),
    vat_summary: buildVatSummary(detailRows),
  };
};

module.exports = {
  buildCashClosureSnapshot,
  buildPaymentSummary,
  buildVatSummary,
  filterArchivedOrdersForPeriod,
  getClosurePeriodBounds,
};
