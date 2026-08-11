const pool = require("../config/dbPool");
const { withTransaction: runInTransaction } = require("../helpers/withTransaction");
const { buildCashClosureSnapshot } = require("../helpers/cashClosure");

const queryResult = async (sql, params = [], connection = pool) => {
  const [result] = await connection.query(sql, params);
  return result;
};

const parseJson = (value, fallback) => {
  if (Array.isArray(value)) return value;
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

const getDatabaseNow = (connection) =>
  queryResult(
    `SELECT DATE_FORMAT(CURRENT_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f')
            AS current_time`,
    [],
    connection
  ).then((rows) => rows[0].current_time);

const getArchivedOrdersForPeriod = ({ shopId, openedAt, closedAt, connection = pool }) => {
  const params = [shopId];
  let dateClause = "AND archives.archived_at <= ?";
  if (openedAt) {
    dateClause = "AND archives.archived_at > ? AND archives.archived_at <= ?";
    params.push(openedAt);
  }
  params.push(closedAt);

  return queryResult(
    `SELECT archives.*,
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
    `SELECT archivesdetail.*
     FROM archivesdetail
     WHERE archivesdetail.orderId IN (?)`,
    [orderIds],
    connection
  );
};

const buildCurrentSnapshot = async ({ shopId, now, connection = pool }) => {
  const lastClosure = await getLastClosure(shopId, connection);
  const openedAt = lastClosure && lastClosure.closed_at ? lastClosure.closed_at : null;
  const closedAt = now || await getDatabaseNow(connection);
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

  return buildCashClosureSnapshot({
    lastClosure,
    archivedOrders,
    detailRows,
    now: closedAt,
  });
};

const mGetCurrentCashClosure = (shopId) => buildCurrentSnapshot({ shopId });

const mCloseCurrentCashClosure = ({ shopId, userId }) =>
  runInTransaction(async (connection) => {
    await lockShopForCashClosure(shopId, connection);
    await getLastClosureForUpdate(shopId, connection);
    const closureNumber = await getNextClosureNumber(shopId, connection);
    const now = await getDatabaseNow(connection);
    const snapshot = await buildCurrentSnapshot({
      shopId,
      now,
      connection,
    });

    if (snapshot.orders_count <= 0) {
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
           vat_summary = ?`,
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
      ],
      connection
    );

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

module.exports = {
  mCloseCurrentCashClosure,
  mGetCashClosureById,
  mGetCashClosures,
  mGetCurrentCashClosure,
};
