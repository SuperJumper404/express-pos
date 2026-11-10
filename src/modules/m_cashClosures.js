const pool = require("../config/dbPool");
const { withTransaction } = require("../helpers/withTransaction");
const { buildCashClosureSnapshot } = require("../helpers/cashClosure");
const { buildCourierCashSummary, cashPostingTime } = require("./m_courierCash");
const { mGetStandaloneReportPayments } = require('./m_terminalReports');
const { validateCashDeclaration, buildCashReconciliation } = require('../helpers/cashReconciliation');

const queryResult = async (sql, params = [], connection = pool) => {
  const [result] = await connection.query(sql, params);
  return result;
};

const parseJson = (value, fallback) => {
  if (value && typeof value === "object") return value;
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
};

const normalizeClosureRow = (row) => {
  if (!row) return null;
  return {
    ...row,
    total_revenue: Number(row.total_revenue || 0),
    payments_summary: parseJson(row.payments_summary, []),
    vat_summary: parseJson(row.vat_summary, []),
    courier_cash: parseJson(row.courier_cash, null),
    standalone_terminal_summary: parseJson(row.standalone_terminal_summary, null),
    reconciliation: parseJson(row.reconciliation, null),
  };
};

const getLastClosure = (shopId, connection = pool) =>
  queryResult(
    `SELECT cash_closures.*,
            DATE_FORMAT(closed_at, '%Y-%m-%d %H:%i:%s.%f') AS closed_at
     FROM cash_closures
     WHERE shopid = ?
     ORDER BY closed_at DESC, id DESC
     LIMIT 1`,
    [shopId],
    connection
  ).then((rows) => rows[0] || null);

const getLastClosureForUpdate = (shopId, connection) =>
  queryResult(
    `SELECT cash_closures.*,
            DATE_FORMAT(closed_at, '%Y-%m-%d %H:%i:%s.%f') AS closed_at
     FROM cash_closures
     WHERE shopid = ?
     ORDER BY closed_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`,
    [shopId],
    connection
  ).then((rows) => rows[0] || null);

const lockShopForCashClosure = (shopId, connection) =>
  queryResult(
    "SELECT id FROM shop WHERE id = ? FOR UPDATE",
    [shopId],
    connection
  ).then((rows) => rows[0] || null);

const getNextClosureNumber = (shopId, connection) =>
  queryResult(
    `SELECT COALESCE(MAX(closure_number), 0) + 1 AS next_number
     FROM cash_closures
     WHERE shopid = ?
     FOR UPDATE`,
    [shopId],
    connection
  ).then((rows) => Number(rows[0] && rows[0].next_number) || 1);

const getDatabaseNow = async (shopId, connection) => {
  const [now] = await queryResult(
    `SELECT DATE_FORMAT(CURRENT_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS session_now,
            DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS database_now`,
    [],
    connection
  );
  if (now.session_now !== now.database_now) {
    // Check all history, including external-card collections and settled debt:
    // disabling delivery cannot make UTC journals safe to compare to local time.
    const [delivery] = await queryResult(
      `SELECT EXISTS(SELECT 1 FROM shop_delivery_settings WHERE shopid=? AND enabled=1)
         OR EXISTS(SELECT 1 FROM delivery_payment_collections WHERE shopid=?)
         OR EXISTS(SELECT 1 FROM courier_cash_remittances WHERE shopid=?)
         OR EXISTS(SELECT 1 FROM courier_cash_adjustments WHERE shopid=?)
         OR EXISTS(SELECT 1 FROM delivery_manual_refunds WHERE shopid=?)
         OR EXISTS(SELECT 1 FROM delivery_register_payments WHERE shopid=?)
         OR EXISTS(SELECT 1 FROM delivery_register_refunds WHERE shopid=?) AS requires_utc`,
      [shopId, shopId, shopId, shopId, shopId, shopId, shopId],
      connection
    );
    if (Number(delivery.requires_utc)) throw new Error("Delivery financial summaries require a UTC database session");
  }
  // Ordinary POS archives and cutoffs retain their existing session time basis.
  return now.session_now;
};

const getArchivedOrdersForPeriod = ({ shopId, openedAt, closedAt, connection = pool }) => {
  const params = [shopId];
  let dateClause = "AND archives.archived_at <= ?";
  if (openedAt) {
    dateClause = "AND archives.archived_at > ? AND archives.archived_at <= ?";
    params.push(openedAt);
  }
  params.push(closedAt);

  return queryResult(
    `SELECT archives.*, CAST(archives.delivery_id AS CHAR) AS delivery_id,
            DATE_FORMAT(archives.archived_at, '%Y-%m-%d %H:%i:%s.%f') AS archived_at
     FROM archives
     WHERE archives.shopid = ?
       ${dateClause}
     ORDER BY archives.archived_at ASC`,
    params,
    connection
  );
};

const getArchiveDetailsForOrders = ({ orderIds, connection = pool }) => {
  if (!orderIds.length) return Promise.resolve([]);
  return queryResult(
    `SELECT vat_rate, total_ht, total_vat, total
     FROM archivesdetail
     WHERE archivesdetail.orderId IN (?)
     UNION ALL
     SELECT charge.vat_rate, charge.total_excl_tax_cents / 100,
            charge.tax_cents / 100, charge.fee_cents / 100
     FROM archives
     JOIN deliveries ON deliveries.id = archives.delivery_id AND deliveries.shopid = archives.shopid
     JOIN delivery_charge_snapshots charge
       ON charge.delivery_id = deliveries.id AND charge.shopid = deliveries.shopid
       AND charge.revision = deliveries.charge_revision
     WHERE archives.id IN (?) AND charge.fee_cents > 0`,
    [orderIds, orderIds],
    connection
  );
};

const buildCashClosures = ({ runInTransaction = withTransaction, clock } = {}) => {
const buildCurrentSnapshot = async ({ shopId, now, connection = pool }) => {
  const lastClosure = await getLastClosure(shopId, connection);
  const openedAt = lastClosure && lastClosure.closed_at ? lastClosure.closed_at : null;
  const closedAt = now || (clock ? cashPostingTime(await clock({ connection })) : await getDatabaseNow(shopId, connection));
  const archivedOrders = await getArchivedOrdersForPeriod({
    shopId,
    openedAt,
    closedAt,
    connection,
  });
  const detailRows = await getArchiveDetailsForOrders({
    orderIds: archivedOrders.map((order) => order.id),
    connection,
  });
  const courierCash = await buildCourierCashSummary({ shopId, openedAt, closedAt, archivedOrders, connection });
  const standalonePayments = await mGetStandaloneReportPayments({ shopId, unclosed: true, closedAt, connection });

  const snapshot = buildCashClosureSnapshot({
    lastClosure,
    archivedOrders,
    detailRows,
    now: closedAt,
    courierCash,
    standalonePayments,
  });
  return { ...snapshot, last_closure_id: lastClosure ? lastClosure.id : null,
    reconciliation: buildCashReconciliation(snapshot), standalone_payment_ids: standalonePayments.map(row => row.id) };
};

const mGetCurrentCashClosure = (shopId) => runInTransaction(async connection => {
  await lockShopForCashClosure(shopId, connection);
  const { standalone_payment_ids, ...snapshot } = await buildCurrentSnapshot({ shopId, connection });
  return snapshot;
});

const mCloseCurrentCashClosure = ({ shopId, userId, declaration, expectedLastClosureId }) =>
  runInTransaction(async (connection) => {
    validateCashDeclaration(declaration);
    await lockShopForCashClosure(shopId, connection);
    const previous = await getLastClosureForUpdate(shopId, connection);
    if (expectedLastClosureId !== undefined && String(expectedLastClosureId || '') !== String(previous ? previous.id : '')) {
      const error = new Error('La caisse a déjà été clôturée. Actualisez le rapport avant de recommencer.');
      error.statusCode = 409;
      throw error;
    }
    const closureNumber = await getNextClosureNumber(shopId, connection);
    const now = clock ? cashPostingTime(await clock({ connection })) : await getDatabaseNow(shopId, connection);
    const snapshot = await buildCurrentSnapshot({
      shopId,
      now,
      connection,
    });

    if (snapshot.orders_count <= 0 && snapshot.standalone_terminal_summary.count <= 0 && snapshot.courier_cash.remittances_count <= 0 && snapshot.courier_cash.adjustments_count <= 0 && snapshot.courier_cash.refunds_count <= 0) {
      const error = new Error("La periode ne contient aucune commande a cloturer.");
      error.statusCode = 400;
      throw error;
    }

    const result = await queryResult(
      `INSERT INTO cash_closures
       SET shopid = ?,
           closure_number = ?,
           opened_at = ?,
           closed_at = ?,
           closed_by_user_id = ?,
           orders_count = ?,
           total_revenue = ?,
           payments_summary = ?,
           vat_summary = ?,
           courier_cash = ?,
           standalone_terminal_summary = ?,
           reconciliation = ?`,
      [
        shopId,
        closureNumber,
        snapshot.opened_at || null,
        snapshot.closed_at,
        userId || null,
        snapshot.orders_count,
        snapshot.total_revenue,
        JSON.stringify(snapshot.payments_summary),
        JSON.stringify(snapshot.vat_summary),
        JSON.stringify(snapshot.courier_cash),
        JSON.stringify(snapshot.standalone_terminal_summary),
        JSON.stringify(buildCashReconciliation(snapshot, declaration)),
      ],
      connection
    );

    if (snapshot.standalone_payment_ids.length) {
      const claimed = await queryResult(`UPDATE stripe_terminal_payments SET cash_closure_id = ?
        WHERE shopid = ? AND id IN (?) AND payment_kind = 'standalone'
          AND status = 'succeeded' AND cash_closure_id IS NULL`,
      [result.insertId, shopId, snapshot.standalone_payment_ids], connection);
      if (claimed.affectedRows !== snapshot.standalone_payment_ids.length) throw new Error('Les paiements TPE de la clôture ont changé. Réessayez.');
    }

    const rows = await queryResult(
      "SELECT * FROM cash_closures WHERE id = ? AND shopid = ? LIMIT 1",
      [result.insertId, shopId],
      connection
    );
    return normalizeClosureRow(rows[0]);
  });

const mGetCashClosures = (shopId) =>
  queryResult(
    `SELECT cash_closures.*, users.username AS closed_by_name
     FROM cash_closures
     LEFT JOIN users ON users.id = cash_closures.closed_by_user_id
     WHERE cash_closures.shopid = ?
     ORDER BY cash_closures.closed_at DESC, cash_closures.id DESC`,
    [shopId]
  ).then((rows) => rows.map(normalizeClosureRow));

const mGetCashClosureById = ({ shopId, id }) =>
  queryResult(
    `SELECT cash_closures.*, users.username AS closed_by_name
     FROM cash_closures
     LEFT JOIN users ON users.id = cash_closures.closed_by_user_id
     WHERE cash_closures.shopid = ? AND cash_closures.id = ?
     LIMIT 1`,
    [shopId, id]
  ).then((rows) => normalizeClosureRow(rows[0]));

return {
  mCloseCurrentCashClosure,
  mGetCashClosureById,
  mGetCashClosures,
  mGetCurrentCashClosure,
};
};
module.exports = { ...buildCashClosures(), buildCashClosures };
