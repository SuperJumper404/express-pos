const { standalonePaymentDto } = require("../helpers/standaloneTerminalPayment");
const { toCents } = require("../helpers/deliveryMoney");

const ERRORS = {
  TERMINAL_INVALID_INPUT: [422, "Parametres de l'historique invalides."],
  TERMINAL_PAYMENT_NOT_FOUND: [404, "Paiement terminal introuvable."],
  TERMINAL_INVALID_ATTACHMENTS: [422, "Une commande jointe n'est pas disponible."],
  TERMINAL_INTERNAL_ERROR: [500, "Impossible de recuperer l'historique terminal."],
};
class TerminalPaymentHistoryError extends Error {
  constructor(code) {
    super(ERRORS[code][1]);
    this.code = code;
    this.statusCode = ERRORS[code][0];
  }
}
const fail = code => { throw new TerminalPaymentHistoryError(code); };
const positiveId = value => {
  if (!((typeof value === "number" || typeof value === "string" && /^\d+$/.test(value))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0)) fail("TERMINAL_INVALID_INPUT");
  return Number(value);
};
const dateString = value => value instanceof Date ? value.toISOString() : String(value);
const archiveAmountCents = value => {
  try { return toCents(value); }
  catch (error) { return fail("TERMINAL_INVALID_ATTACHMENTS"); }
};
const pagination = input => {
  const page = positiveId(input.page === undefined ? 1 : input.page);
  const itemsPerPage = positiveId(input.itemsPerPage === undefined ? 10 : input.itemsPerPage);
  if (itemsPerPage > 100 || page > 1000000) fail("TERMINAL_INVALID_INPUT");
  if (input.search !== undefined && (typeof input.search !== "string" || input.search.length > 200)) fail("TERMINAL_INVALID_INPUT");
  return { page, itemsPerPage, offset: (page - 1) * itemsPerPage, search: (input.search || "").trim() };
};
const sortColumns = {
  eventAt: "event_at", created: "event_at", ordernumber: "reference", username: "table_name", customer: "customer",
  taken_by_name: "taken_by_name", prepared_by_name: "prepared_by_name", subtotal: "amount", payment_status: "payment_status", status: "entry_status",
};
const sortOptions = input => {
  const sortBy = input.sortBy === undefined ? "eventAt" : input.sortBy;
  if (typeof sortBy !== "string" || !Object.prototype.hasOwnProperty.call(sortColumns, sortBy)) fail("TERMINAL_INVALID_INPUT");
  const descending = input.sortDesc === undefined ? true : input.sortDesc;
  if (![true, false, "true", "false"].includes(descending)) fail("TERMINAL_INVALID_INPUT");
  return { column: sortColumns[sortBy], direction: descending === true || descending === "true" ? "DESC" : "ASC" };
};
const queryWith = async (connection, sql, values = []) => {
  if (typeof connection.promise === "function") return new Promise((resolve, reject) => {
    connection.query(sql, values, (error, result) => error ? reject(error) : resolve(result));
  });
  return (await connection.query(sql, values))[0];
};
const visible = "COALESCE(a.hidden_from_history, 0) = 0";
const archiveJoins = "LEFT JOIN service_points sp ON sp.id = a.service_point_id AND sp.shopid = a.shopid";
const paymentDisplayJoins = `LEFT JOIN users cashier ON cashier.id = p.cashier_user_id AND cashier.shopid = p.shopid
  LEFT JOIN stripe_terminal_readers reader ON reader.id = p.terminal_reader_id AND reader.shopid = p.shopid`;
const paymentProjection = `SELECT p.*, (SELECT COUNT(*) FROM stripe_terminal_payment_attachments c
  WHERE c.shopid = p.shopid AND c.terminal_payment_id = p.id) AS attachments_count
  FROM stripe_terminal_payments p`;
const historyPaymentProjection = `SELECT p.*, cashier.username AS cashier_name, reader.label AS reader_label,
  (SELECT COUNT(*) FROM stripe_terminal_payment_attachments c
    WHERE c.shopid = p.shopid AND c.terminal_payment_id = p.id) AS attachments_count
  FROM stripe_terminal_payments p ${paymentDisplayJoins}`;
const archiveProjection = `SELECT a.*, CAST(a.delivery_id AS CHAR) AS delivery_id,
  CAST(a.customer_account_id AS CHAR) AS customer_account_id, sp.name AS service_point_name,
  sp.name AS username,
  CASE WHEN a.payment_provider = 'stripe_terminal' AND terminal_payment.status = 'succeeded'
    THEN ROUND(a.subtotal * 100) ELSE NULL END AS stripe_terminal_amount_cents,
  CASE WHEN a.payment_provider = 'stripe_terminal' AND terminal_payment.status = 'succeeded'
    THEN terminal_payment.stripe_charge_id ELSE NULL END AS stripe_terminal_charge_id,
  CASE WHEN a.payment_provider = 'stripe_terminal' AND terminal_payment.status = 'succeeded'
    THEN terminal_payment.card_receipt_details ELSE NULL END AS stripe_terminal_card_receipt_details
  FROM archives a ${archiveJoins}
  LEFT JOIN stripe_terminal_payments terminal_payment ON terminal_payment.id = a.stripe_terminal_payment_id
    AND terminal_payment.shopid = a.shopid`;

const buildTerminalPaymentHistoryModule = ({ connection, withTransaction, deliveryStore } = {}) => {
  if (!connection || typeof connection.query !== "function") throw new Error("A database connection is required");
  const query = (sql, values, db = connection) => queryWith(db, sql, values);
  const transaction = work => (withTransaction || require("../helpers/withTransaction").createTransactionRunner(connection))(work);
  const paymentById = async (shopId, paymentId, db = connection, lock = false) => {
    const rows = await query(`${paymentProjection} WHERE p.shopid = ? AND p.id = ?
      AND p.payment_kind = 'standalone' LIMIT 1${lock ? " FOR UPDATE" : ""}`, [shopId, paymentId], db);
    if (!rows[0] || rows[0].payment_kind !== "standalone" || Number(rows[0].shopid) !== shopId) fail("TERMINAL_PAYMENT_NOT_FOUND");
    return rows[0];
  };
  const attachmentResponse = async (shopId, paymentId, db = connection) => {
    const session = await paymentById(shopId, paymentId, db);
    const rows = await query(`SELECT a.archive_id, a.order_id, a.order_number, a.amount_cents, a.created_at,
      CASE WHEN a.archive_id IS NOT NULL THEN source.id IS NOT NULL ELSE live_order.id IS NOT NULL END AS available
      FROM stripe_terminal_payment_attachments a
      LEFT JOIN archives source ON source.id = a.archive_id AND source.shopid = a.shopid
        AND COALESCE(source.hidden_from_history, 0) = 0
      LEFT JOIN orders live_order ON a.archive_id IS NULL AND live_order.id = a.order_id AND live_order.shopid = a.shopid
      WHERE a.shopid = ? AND a.terminal_payment_id = ? ORDER BY a.created_at, a.archive_id`, [shopId, paymentId], db);
    return { payment: standalonePaymentDto(session), attachments: rows.map(row => ({
      archiveId: row.archive_id == null ? null : Number(row.archive_id),
      ...(row.order_id != null && { orderId: Number(row.order_id) }),
      orderNumber: String(row.order_number), amountCents: Number(row.amount_cents),
      attachedAt: dateString(row.created_at), available: Number(row.available) === 1,
    })) };
  };
  const getAttachments = async input => attachmentResponse(positiveId(input.shopId), positiveId(input.paymentId));
  const addAttachments = async input => {
    const shopId = positiveId(input.shopId);
    const paymentId = positiveId(input.paymentId);
    const userId = positiveId(input.userId);
    const archives = input.archiveIds === undefined ? [] : input.archiveIds;
    const orders = input.orderIds === undefined ? [] : input.orderIds;
    if (![archives, orders].every(ids => Array.isArray(ids) && ids.every(id => Number.isSafeInteger(id) && id > 0))
      || archives.length + orders.length < 1 || archives.length + orders.length > 100) fail("TERMINAL_INVALID_INPUT");
    const archiveIds = [...new Set(archives)].sort((a, b) => a - b);
    const orderIds = [...new Set(orders)].sort((a, b) => a - b);
    return transaction(async db => {
      // Lock active sources first, so archiving cannot remove a source while it is linked.
      const activeRows = orderIds.length ? await query(`SELECT o.id, o.ordernumber, o.subtotal FROM orders o
        WHERE o.shopid = ? AND o.id IN (${orderIds.map(() => "?").join(", ")}) ORDER BY o.id FOR UPDATE`, [shopId, ...orderIds], db) : [];
      const rows = archiveIds.length ? await query(`SELECT a.id, a.ordernumber, a.subtotal FROM archives a
        WHERE a.shopid = ? AND a.id IN (${archiveIds.map(() => "?").join(", ")}) AND ${visible}
        ORDER BY a.id FOR UPDATE`, [shopId, ...archiveIds], db) : [];
      if (rows.length !== archiveIds.length || rows.some(row => !archiveIds.includes(Number(row.id)))
        || activeRows.length !== orderIds.length || activeRows.some(row => !orderIds.includes(Number(row.id)))) fail("TERMINAL_INVALID_ATTACHMENTS");
      await paymentById(shopId, paymentId, db, true);
      for (const row of [...rows.map(row => ({ ...row, source: 'archive' })), ...activeRows.map(row => ({ ...row, source: 'order' }))]) {
        const amountCents = archiveAmountCents(row.subtotal);
        await query(`INSERT INTO stripe_terminal_payment_attachments SET ?
          ON DUPLICATE KEY UPDATE terminal_payment_id = VALUES(terminal_payment_id)`, [{
          shopid: shopId, terminal_payment_id: paymentId, archive_id: row.source === 'archive' ? Number(row.id) : null,
          ...(row.source === 'order' && { order_id: Number(row.id) }),
          order_number: String(row.ordernumber || row.id), amount_cents: amountCents, attached_by_user_id: userId,
        }], db);
      }
      return attachmentResponse(shopId, paymentId, db);
    });
  };
  const removeAttachment = async input => {
    const shopId = positiveId(input.shopId);
    const paymentId = positiveId(input.paymentId);
    if (input.archiveId !== undefined && input.orderId !== undefined) fail("TERMINAL_INVALID_INPUT");
    const column = input.orderId === undefined ? "archive_id" : "order_id";
    const sourceId = positiveId(input.orderId === undefined ? input.archiveId : input.orderId);
    positiveId(input.userId);
    return transaction(async db => {
      await paymentById(shopId, paymentId, db, true);
      await query(`DELETE FROM stripe_terminal_payment_attachments WHERE shopid = ? AND terminal_payment_id = ? AND ${column} = ?`, [shopId, paymentId, sourceId], db);
      return attachmentResponse(shopId, paymentId, db);
    });
  };

  const listEntries = async input => {
    const shopId = positiveId(input.shopId);
    const { itemsPerPage, offset, search } = pagination(input);
    const { column, direction } = sortOptions(input);
    const values = [shopId];
    const archiveSearch = search ? "AND CONCAT_WS(' ', a.ordernumber, a.customer, sp.name, a.taken_by_name, a.prepared_by_name, a.payment_status) LIKE ?" : "";
    if (search) values.push(`%${search}%`);
    values.push(shopId);
    const paymentSearch = search ? "AND CONCAT_WS(' ', 'Paiement TPE', CONCAT('TPE #', p.id), p.status, p.amount_cents / 100, cashier.username, reader.label) LIKE ?" : "";
    if (search) values.push(`%${search}%`);
    const union = `SELECT a.id, 'order' AS entry_type, COALESCE(a.archived_at, a.created) AS event_at,
      CAST(a.ordernumber AS CHAR) AS reference, sp.name AS table_name, a.customer,
      a.taken_by_name, a.prepared_by_name, a.subtotal AS amount, a.payment_status, CAST(a.status AS CHAR) AS entry_status
      FROM archives a ${archiveJoins} WHERE a.shopid = ? AND ${visible} ${archiveSearch}
      UNION ALL
      SELECT p.id, 'terminal_payment', COALESCE(p.confirmed_at, p.created_at), CONCAT('TPE #', p.id),
      NULL, NULL, cashier.username, NULL, p.amount_cents / 100, p.status, p.status
      FROM stripe_terminal_payments p ${paymentDisplayJoins} WHERE p.shopid = ? AND p.payment_kind = 'standalone' ${paymentSearch}`;
    const totalRows = await query(`SELECT COUNT(*) AS total FROM (${union}) history_entries`, values);
    const keys = await query(`SELECT * FROM (${union}) history_entries
      ORDER BY ${column} ${direction}, ${column === "event_at" ? "" : "event_at DESC, "}entry_type ASC, id DESC LIMIT ? OFFSET ?`, [...values, itemsPerPage, offset]);
    const orderIds = keys.filter(row => row.entry_type === "order").map(row => Number(row.id));
    const paymentIds = keys.filter(row => row.entry_type === "terminal_payment").map(row => Number(row.id));
    let orders = orderIds.length ? await query(`${archiveProjection} WHERE a.shopid = ? AND ${visible}
      AND a.id IN (${orderIds.map(() => "?").join(", ")})`, [shopId, ...orderIds]) : [];
    const contexts = new Map();
    orders = await Promise.all(orders.map(async row => {
      if (row.delivery_id == null) return row;
      const deliveries = deliveryStore || require("./m_deliveryOrders");
      const key = `${row.shopid}:${row.delivery_id}`;
      if (!contexts.has(key)) contexts.set(key, deliveries.resolveDeliveryOrder({ shopId: row.shopid, deliveryId: row.delivery_id, connection }));
      const resolved = await contexts.get(key);
      if (!resolved) fail("TERMINAL_INTERNAL_ERROR");
      const { financials, deliveryStatus } = deliveries.toDeliveryView(resolved);
      return { ...row, delivery_id: resolved.delivery.id, customer_account_id: resolved.delivery.customer_account_id,
        originalorderID: resolved.delivery.origin_order_id, payment_order_id: resolved.delivery.origin_order_id,
        delivery_status: deliveryStatus, financials, ...financials };
    }));
    const payments = paymentIds.length ? await query(`${historyPaymentProjection} WHERE p.shopid = ? AND p.payment_kind = 'standalone'
      AND p.id IN (${paymentIds.map(() => "?").join(", ")})`, [shopId, ...paymentIds]) : [];
    const items = keys.map(key => {
      if (key.entry_type === "order") {
        const order = orders.find(row => Number(row.id) === Number(key.id));
        return order && { ...order, entryType: "order", rowKey: `order:${order.id}`, eventAt: dateString(key.event_at) };
      }
      const session = payments.find(row => Number(row.id) === Number(key.id));
      if (!session) return null;
      return { id: session.id, entryType: "terminal_payment", rowKey: `terminal-payment:${session.id}`, eventAt: dateString(key.event_at),
        ordernumber: `TPE #${session.id}`, username: null, service_point_name: null, customer: null,
        taken_by_name: session.cashier_name || null, readerLabel: session.reader_label || null,
        prepared_by_name: null, subtotal: session.amount_cents / 100,
        payment_status: session.status, status: null, terminalPayment: standalonePaymentDto(session) };
    }).filter(Boolean);
    return { items, total: Number(totalRows[0].total) };
  };

  const listAttachmentCandidates = async input => {
    const shopId = positiveId(input.shopId);
    const { itemsPerPage, offset, search } = pagination(input);
    if (input.includeActive === true || input.includeActive === 'true') {
      const filters = search ? "AND CONCAT_WS(' ', a.ordernumber, a.customer, sp.name) LIKE ?" : "";
      const values = [shopId, ...(search ? [`%${search}%`] : []), shopId, ...(search ? [`%${search}%`] : [])];
      const union = `SELECT a.id, 'archive' AS source_type, a.ordernumber, a.subtotal, a.created, a.status,
        COALESCE(a.archived_at, a.created) AS event_at, sp.name AS service_point_name, a.customer
        FROM archives a ${archiveJoins} WHERE a.shopid = ? AND ${visible} ${filters}
        UNION ALL
        SELECT a.id, 'order', a.ordernumber, a.subtotal, a.created, a.status, a.created, sp.name, a.customer
        FROM orders a ${archiveJoins} WHERE a.shopid = ? ${filters}`;
      const totals = await query(`SELECT COUNT(*) AS total FROM (${union}) attachment_candidates`, values);
      const rows = await query(`SELECT * FROM (${union}) attachment_candidates ORDER BY event_at DESC, source_type, id DESC LIMIT ? OFFSET ?`, [...values, itemsPerPage, offset]);
      return { items: rows.map(row => ({ archiveId: row.source_type === 'archive' ? Number(row.id) : null,
        ...(row.source_type === 'order' && { orderId: Number(row.id) }), orderStatus: row.status == null ? null : Number(row.status),
        orderNumber: String(row.ordernumber || row.id), amountCents: archiveAmountCents(row.subtotal), createdAt: dateString(row.created),
        tableName: row.service_point_name || null, customer: row.customer || null })), total: Number(totals[0].total) };
    }
    const values = [shopId];
    const searchClause = search ? "AND CONCAT_WS(' ', a.ordernumber, a.customer, sp.name) LIKE ?" : "";
    if (search) values.push(`%${search}%`);
    const from = `FROM archives a ${archiveJoins} WHERE a.shopid = ? AND ${visible} ${searchClause}`;
    const totalRows = await query(`SELECT COUNT(*) AS total ${from}`, values);
    const rows = await query(`SELECT a.id, a.ordernumber, a.subtotal, a.created, sp.name AS service_point_name,
      a.customer ${from} ORDER BY COALESCE(a.archived_at, a.created) DESC, a.id DESC LIMIT ? OFFSET ?`, [...values, itemsPerPage, offset]);
    return { items: rows.map(row => ({ archiveId: Number(row.id), orderNumber: String(row.ordernumber || row.id),
      amountCents: archiveAmountCents(row.subtotal), createdAt: dateString(row.created),
      tableName: row.service_point_name || null, customer: row.customer || null })), total: Number(totalRows[0].total) };
  };
  return { listEntries, listAttachmentCandidates, getAttachments, addAttachments, removeAttachment };
};

module.exports = { buildTerminalPaymentHistoryModule, TerminalPaymentHistoryError };
