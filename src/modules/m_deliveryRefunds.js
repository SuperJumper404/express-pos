const crypto = require("crypto");
const DomainError = require("../helpers/domainError");
const { withTransaction } = require("../helpers/withTransaction");
const { isDeliveryOperator, forbidden } = require("../helpers/deliveryAuthorization");
const { toCents } = require("../helpers/deliveryMoney");
const { resolveDeliveryOrder, toDeliveryView } = require("./m_deliveryOrders");
const { buildCourierCash, cashPostingTime } = require("./m_courierCash");

const query = async (connection, sql, values = []) => (await connection.query(sql, values))[0];
const invalid = () => new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid manual delivery refund");
const conflict = (code = "DELIVERY_REFUND_NOT_ALLOWED") => new DomainError(409, code, "Manual refund conflicts with current financial state");
const repository = {
  lockShop: async ({ shopId, connection }) => (await query(connection, "SELECT id FROM shop WHERE id=? FOR UPDATE", [shopId]))[0],
  resolve: resolveDeliveryOrder,
  source: async ({ shopId, deliveryId, connection }) => {
    const rows = await query(connection, `SELECT *,CAST(id AS CHAR) id,
      CAST(delivery_id AS CHAR) delivery_id FROM delivery_payment_collections WHERE shopid=? AND delivery_id=?`, [shopId, deliveryId]);
    return rows.length === 1 ? rows[0] : null;
  },
  account: async ({ shopId, id, connection }) => (await query(connection,
    "SELECT id,shopid,access,status,module_permissions FROM users WHERE shopid=? AND id=? FOR UPDATE", [shopId, id]))[0],
  payment: async ({ shopId, paymentId, connection }) => (await query(connection,
    "SELECT * FROM payments WHERE shop_id=? AND id=? FOR UPDATE", [shopId, paymentId]))[0],
  replay: async ({ shopId, idempotencyKey, connection }) => (await query(connection,
    "SELECT CAST(id AS CHAR) id,request_hash,result FROM delivery_manual_refunds WHERE shopid=? AND idempotency_key=?", [shopId, idempotencyKey]))[0],
  postingTime: async ({ connection }) => (await query(connection,
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') now"))[0].now,
  appendRefund: async ({ row, connection }) => {
    await query(connection, "INSERT INTO delivery_manual_refunds SET ?", [row]);
    return (await query(connection, "SELECT CAST(LAST_INSERT_ID() AS CHAR) id"))[0].id;
  },
  markRefunded: async ({ current, payment, now, connection }) => {
    const table = current.orderKind === "archive" ? "archives" : "orders";
    const order = await query(connection, `UPDATE ${table} SET payment_status='refunded' WHERE shopid=? AND id=? AND payment_status='paid'`, [current.delivery.shopid, current.order.id]);
    const settled = await query(connection, `UPDATE payments SET status='refunded',refund_status='succeeded',
      refund_failure_reason=NULL,refunded_at=?,updated=? WHERE shop_id=? AND id=? AND status='succeeded'`, [now, now, current.delivery.shopid, payment.id]);
    if (order.affectedRows !== 1 || settled.affectedRows !== 1) throw conflict();
  },
  applyCashRefund: input => buildCourierCash().applyConfirmedRefund(input),
};

const buildDeliveryRefunds = ({ repository: supplied = {}, runInTransaction = withTransaction, clock } = {}) => {
  const repo = { ...repository, ...supplied };
  const refund = async input => {
    const { actor, deliveryId, returnSource, reason, idempotencyKey } = input;
    if (Object.keys(input).some(key => !["actor", "deliveryId", "returnSource", "reason", "idempotencyKey"].includes(key)) ||
      typeof deliveryId !== "string" || !/^[1-9]\d{0,19}$/.test(deliveryId) || !["register", "courier", "external_card"].includes(returnSource) ||
      typeof reason !== "string" || !reason.trim() || reason.length > 2000 || typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 191) throw invalid();
    if (!actor || actor.subject !== "staff" || !actor.id || !actor.shopId) throw forbidden();
    const hash = crypto.createHash("sha256").update(JSON.stringify({ operation: "manualDeliveryRefund", shopId: String(actor.shopId),
      actorId: String(actor.id), deliveryId, returnSource, reason })).digest("hex");
    try {
      return await runInTransaction(async connection => {
        if (!await repo.lockShop({ shopId: actor.shopId, connection })) throw forbidden();
        const current = await repo.resolve({ shopId: actor.shopId, deliveryId, connection, forUpdate: true });
        if (!current) throw new DomainError(404, "DELIVERY_NOT_FOUND", "Delivery not found");
        // Immutable source identity is read after the shop barrier, before taking
        // actor/holder locks in deterministic order; no journal gap lock is used.
        const collection = await repo.source({ shopId: actor.shopId, deliveryId, connection });
        const accounts = new Map();
        for (const id of [...new Set([Number(actor.id), ...(collection ? [Number(collection.courier_id)] : [])])].sort((a, b) => a - b)) {
          accounts.set(id, await repo.account({ shopId: actor.shopId, id, connection }));
        }
        const account = accounts.get(Number(actor.id));
        if (!account || account.access == null || Number(account.status) !== 1 || !isDeliveryOperator({ subject: "staff", access: account.access, module_permissions: account.module_permissions })) throw forbidden();
        const replay = await repo.replay({ shopId: actor.shopId, idempotencyKey, connection });
        if (replay) {
          if (replay.request_hash !== hash) throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
          return { refundId: replay.id, ...(typeof replay.result === "string" ? JSON.parse(replay.result) : replay.result) };
        }
        if (!collection || !accounts.get(Number(collection.courier_id))) throw conflict();
        if (returnSource === "courier" && Number(account.id) === Number(collection.courier_id)) throw forbidden();
        const { delivery, order } = current;
        const payment = await repo.payment({ shopId: actor.shopId, paymentId: collection.payment_id, connection });
        const amountCents = Number(collection.amount_cents);
        const accepted = toDeliveryView({ ...current, actor: { ...actor, access: Number(account.access), module_permissions: account.module_permissions } });
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents !== toCents(accepted.financials.grand_total) ||
          order.payment_status !== "paid" || order.payment_provider || order.stripe_payment_intent_id || order.stripe_terminal_payment_id ||
          !payment || Number(payment.order_id) !== Number(delivery.origin_order_id) || payment.status !== "succeeded" ||
          Number(payment.amount_cents) !== amountCents || payment.currency !== "eur" || payment.stripe_charge_id || payment.stripe_refund_id || payment.refund_status ||
          !new RegExp(`^manual_delivery:${deliveryId}:\\d+$`).test(payment.stripe_payment_intent_id) ||
          (collection.method === "cash" ? !["register", "courier"].includes(returnSource) : collection.method !== "external_card" || returnSource !== "external_card")) throw conflict();
        const now = clock ? cashPostingTime(await clock({ connection })) : await repo.postingTime({ connection });
        const result = { deliveryId, collectionId: collection.id, paymentId: payment.id, amountCents, method: collection.method, returnSource,
          physicalHolderId: returnSource === "courier" ? collection.courier_id : returnSource === "register" ? account.id : null,
          authorizedById: account.id, reason, createdAt: now, confirmation: "restaurant_declaration", providerVerified: false };
        const refundId = await repo.appendRefund({ connection, row: { shopid: account.shopid, delivery_id: deliveryId,
          payment_id: payment.id, collection_id: collection.id, courier_id: collection.courier_id, method: collection.method, amount_cents: amountCents,
          return_source: returnSource, physical_holder_id: result.physicalHolderId, authorized_by_id: account.id, reason,
          idempotency_key: idempotencyKey, request_hash: hash, result: JSON.stringify(result), created_at: now } });
        await repo.markRefunded({ current, payment, now, connection });
        await repo.applyCashRefund({ shopId: account.shopid, refundId, connection });
        return { refundId, ...result };
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
      throw error;
    }
  };
  return { refund };
};
module.exports = { buildDeliveryRefunds };
