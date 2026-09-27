const pool = require("../config/dbPool");
const { createTransactionRunner } = require("../helpers/withTransaction");
const {
  CASH_REGISTER_DUE_AND_ARCHIVABLE_SQL,
  isCashRegisterOrderDueAndArchivable,
} = require("../helpers/cashRegisterPayment");

const queryResult = async (connection, sql, params = []) => {
  const [result] = await connection.query(sql, params);
  return result;
};

const first = (rows) => rows[0] || null;
const decimal = (cents) => Number((cents / 100).toFixed(2));
const cents = (value) => Math.round(Number(value || 0) * 100);

const buildVatBreakdown = (details) => {
  const totals = new Map();
  for (const detail of details) {
    const numericRate = Number(detail.vat_rate);
    const vatRate = Number.isFinite(numericRate) ? numericRate.toFixed(2) : "Non renseignee";
    const current = totals.get(vatRate) || {
      vatRate,
      totalHtCents: 0,
      totalVatCents: 0,
      totalTtcCents: 0,
    };
    current.totalHtCents += cents(detail.total_ht);
    current.totalVatCents += cents(detail.total_vat);
    current.totalTtcCents += cents(detail.total);
    totals.set(vatRate, current);
  }
  return [...totals.values()].map((row) => ({
    vatRate: row.vatRate,
    totalHt: decimal(row.totalHtCents),
    totalVat: decimal(row.totalVatCents),
    totalTtc: decimal(row.totalTtcCents),
  }));
};

const buildCashRegisterSettlementModule = ({ connection = pool } = {}) => {
  const query = (sql, params) => queryResult(connection, sql, params);

  const findByIdempotencyKey = async ({ shopId, idempotencyKey }) => first(await query(
    `SELECT * FROM cash_register_settlements
     WHERE shopid = ? AND idempotency_key = ?
     LIMIT 1`,
    [shopId, idempotencyKey],
  ));

  const getSettlementReceipt = async ({ shopId, settlementId }) => {
    const settlement = first(await query(
      `SELECT * FROM cash_register_settlements
       WHERE shopid = ? AND id = ?
       LIMIT 1`,
      [shopId, settlementId],
    ));
    if (!settlement) return null;

    const archivedOrders = await query(
      `SELECT * FROM archives
       WHERE shopid = ? AND cash_register_settlement_id = ?
       ORDER BY id`,
      [shopId, settlementId],
    );
    const archiveIds = archivedOrders.map((order) => order.id);
    const details = archiveIds.length ? await query(
      `SELECT * FROM archivesdetail
       WHERE orderId IN (?)
       ORDER BY orderId, id`,
      [archiveIds],
    ) : [];
    const detailsByOrder = new Map();
    for (const detail of details) {
      const orderDetails = detailsByOrder.get(detail.orderId) || [];
      orderDetails.push(detail);
      detailsByOrder.set(detail.orderId, orderDetails);
    }

    return {
      ...settlement,
      archivedOrders: archivedOrders.map((order) => ({
        ...order,
        details: detailsByOrder.get(order.id) || [],
      })),
      vatBreakdown: buildVatBreakdown(details),
    };
  };

  return {
    connection,
    withTransaction: (work) => createTransactionRunner(connection)(
      (transactionConnection) => work(buildCashRegisterSettlementModule({
        connection: transactionConnection,
      })),
    ),
    lockShop: async ({ shopId }) => first(await query(
      "SELECT id FROM shop WHERE id = ? FOR UPDATE",
      [shopId],
    )),
    lockOrders: ({ shopId, orderIds }) => query(
      `SELECT orders.*, service_points.name AS service_point_name,
              service_points.type AS service_point_type,
              stock_reservations.stock_reservation_status
       FROM orders
       LEFT JOIN service_points ON service_points.id = orders.service_point_id
         AND service_points.shopid = orders.shopid
       LEFT JOIN (
         SELECT order_id, MAX(status) AS stock_reservation_status
         FROM order_stock_reservations
         GROUP BY order_id
       ) stock_reservations ON stock_reservations.order_id = orders.id
       WHERE orders.shopid = ? AND orders.id IN (?)
       ORDER BY orders.id FOR UPDATE`,
      [shopId, orderIds],
    ),
    listEligibleTableOrders: async ({ shopId, servicePointId, customerId }) => {
      const tableClause = servicePointId == null
        ? "orders.service_point_id IS NULL AND orders.customerID = ?"
        : "orders.service_point_id = ?";
      const rows = await query(
        `SELECT orders.*, service_points.name AS service_point_name,
                service_points.type AS service_point_type,
                stock_reservations.stock_reservation_status
         FROM orders
         LEFT JOIN service_points ON service_points.id = orders.service_point_id
           AND service_points.shopid = orders.shopid
         LEFT JOIN (
           SELECT order_id, MAX(status) AS stock_reservation_status
           FROM order_stock_reservations
           GROUP BY order_id
         ) stock_reservations ON stock_reservations.order_id = orders.id
         WHERE orders.shopid = ? AND ${tableClause}
           AND orders.status = 3 AND ${CASH_REGISTER_DUE_AND_ARCHIVABLE_SQL}
         ORDER BY orders.id FOR UPDATE`,
        [shopId, servicePointId == null ? customerId : servicePointId],
      );
      return rows.filter(isCashRegisterOrderDueAndArchivable);
    },
    findByIdempotencyKey,
    insertSettlement: async (data) => {
      const result = await query(
        `INSERT INTO cash_register_settlements
           (shopid, service_point_id, table_reference, payment_method,
            subtotal_before_discount, discount_type, discount_value,
            discount_amount, total_amount, stripe_terminal_payment_id,
            idempotency_key, request_fingerprint, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.shopid,
          data.service_point_id,
          data.table_reference,
          data.payment_method,
          data.subtotal_before_discount,
          data.discount_type,
          data.discount_value,
          data.discount_amount,
          data.total_amount,
          data.stripe_terminal_payment_id,
          data.idempotency_key,
          data.request_fingerprint,
          data.created_by_user_id,
        ],
      );
      return first(await query(
        "SELECT * FROM cash_register_settlements WHERE shopid = ? AND id = ? LIMIT 1",
        [data.shopid, result.insertId],
      ));
    },
    findTerminalPayment: async ({ shopId, paymentId }) => first(await query(
      `SELECT * FROM stripe_terminal_payments
       WHERE shopid = ? AND id = ?
       LIMIT 1`,
      [shopId, paymentId],
    )),
    listTerminalAllocations: ({ shopId, paymentId }) => query(
      `SELECT * FROM stripe_terminal_payment_orders
       WHERE shopid = ? AND terminal_payment_id = ?
       ORDER BY order_id`,
      [shopId, paymentId],
    ),
    getSettlementReceipt,
  };
};

module.exports = { buildCashRegisterSettlementModule };
