const crypto = require("crypto");
const DomainError = require("../helpers/domainError");
const { withTransaction } = require("../helpers/withTransaction");
const { assertCents, fromCents } = require("../helpers/deliveryMoney");
const { assertDeliveryCollectionAllowed, buildCashRegisterCollectionFields } = require("../helpers/cashRegisterPayment");
const { isCourier, assertDeliveryOwner, forbidden } = require("../helpers/deliveryAuthorization");
const { resolveDeliveryOrder, toDeliveryView } = require("./m_deliveryOrders");

const query = async (connection, sql, values = []) => {
  if (!connection) throw new Error("Delivery collection requires the caller's transaction");
  return (await connection.query(sql, values))[0];
};
const invalid = () => new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid delivery collection");
const conflict = (code = "DELIVERY_PAYMENT_NOT_SETTLED") => new DomainError(409, code, "Delivery collection conflicts with current state");
const insertedId = async connection => (await query(connection, "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id"))[0].id;

const repository = {
  lockShop: async ({ shopId, connection }) => (await query(connection, "SELECT id FROM shop WHERE id = ? FOR UPDATE", [shopId]))[0],
  resolve: resolveDeliveryOrder,
  findAccount: async ({ id, shopId, connection }) => (await query(connection,
    "SELECT id,shopid,access,status FROM users WHERE shopid = ? AND id = ? FOR UPDATE", [shopId, id]))[0],
  // The shop barrier precedes the RR snapshot. Missing keys must not take global
  // journal gap locks (dispatch uses that journal concurrently on other missions).
  findCollection: async ({ shopId, idempotencyKey, connection }) => (await query(connection,
    `SELECT CAST(id AS CHAR) AS id, CAST(delivery_id AS CHAR) AS delivery_id, courier_id, request_hash
     FROM delivery_payment_collections WHERE shopid = ? AND idempotency_key = ?`, [shopId, idempotencyKey]))[0],
  assertNoProviderPayment: async ({ shopId, orderId, paymentId, connection }) => {
    const terminal = await query(connection, `SELECT p.id FROM stripe_terminal_payment_orders a
      JOIN stripe_terminal_payments p ON p.id = a.terminal_payment_id AND p.shopid = a.shopid
      WHERE a.shopid = ? AND a.order_id = ? AND p.status IN ('creating','processing') LIMIT 1 FOR UPDATE`, [shopId, orderId]);
    // Keep this current read on the owned order's range even for tiny tables:
    // an optimizer-selected primary scan can lock another shop's new payment.
    const payments = await query(connection,
      "SELECT id FROM payments FORCE INDEX (order_id) WHERE shop_id = ? AND order_id = ? AND id <> ? AND status <> 'canceled' LIMIT 1 FOR UPDATE", [shopId, orderId, paymentId]);
    if (terminal.length || payments.length) throw conflict();
  },
  postingTime: async ({ connection }) => (await query(connection,
    "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') AS now"))[0].now,
  settle: async ({ current, fields, connection }) => {
    const table = current.orderKind === "archive" ? "archives" : "orders";
    const result = await query(connection, `UPDATE ${table} SET ? WHERE shopid = ? AND id = ? AND payment_status = 'unpaid'`,
      [fields, current.delivery.shopid, current.order.id]);
    if (result.affectedRows !== 1) throw conflict();
  },
  appendPayment: async ({ payment, connection }) => {
    await query(connection, "INSERT INTO payments SET ?", [payment]);
    // A legacy INT FK, still retrieved without relying on mysql2 insertId coercion.
    return insertedId(connection);
  },
  appendCollection: async ({ collection, connection }) => {
    await query(connection, "INSERT INTO delivery_payment_collections SET ?", [collection]);
    return insertedId(connection);
  },
  saveVersion: ({ delivery, now, connection }) => query(connection,
    "UPDATE deliveries SET version = ?,updated_at = ? WHERE shopid = ? AND id = ?",
    [delivery.version, now, delivery.shopid, delivery.id]),
  appendEvent: ({ event, connection }) => query(connection, "INSERT INTO delivery_events SET ?", [event]),
};

const explicitTime = value => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid delivery posting time");
  return date.toISOString().replace("T", " ").replace("Z", "000");
};

const buildDeliveryCollections = ({ repository: supplied = {}, runInTransaction = withTransaction, clock } = {}) => {
  const repo = { ...repository, ...supplied };
  const collect = async input => {
    const { actor, deliveryId, method, expectedVersion, idempotencyKey } = input;
    if (Object.keys(input).some(key => !["actor", "deliveryId", "method", "expectedVersion", "idempotencyKey"].includes(key)) ||
      !["cash", "external_card"].includes(method) || typeof deliveryId !== "string" || !/^[1-9]\d{0,19}$/.test(deliveryId) ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || typeof idempotencyKey !== "string" ||
      !idempotencyKey.trim() || idempotencyKey.length > 191) throw invalid();
    if (!actor || actor.subject !== "staff" || !actor.id || !actor.shopId) throw forbidden();
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({
      operation: "collectPayment", shopId: String(actor.shopId), actorId: String(actor.id),
      deliveryId: String(deliveryId), method, expectedVersion,
    })).digest("hex");
    try {
      return await runInTransaction(async connection => {
        // Closure, archive and future remittance take this same barrier first.
        if (!await repo.lockShop({ shopId: actor.shopId, connection })) throw forbidden();
        const current = await repo.resolve({ shopId: actor.shopId, deliveryId, connection, forUpdate: true });
        if (!current) throw new DomainError(404, "DELIVERY_NOT_FOUND", "Delivery not found");
        const account = await repo.findAccount({ id: actor.id, shopId: actor.shopId, connection });
        if (!account || Number(account.status) !== 1 || !isCourier({ subject: "staff", access: account.access })) throw forbidden();
        const effectiveActor = { subject: "staff", id: account.id, shopId: account.shopid, access: Number(account.access) };
        assertDeliveryOwner(effectiveActor, current.delivery);
        const { delivery, order } = current;
        const replay = await repo.findCollection({ shopId: effectiveActor.shopId, idempotencyKey, connection });
        if (replay) {
          if (replay.request_hash !== requestHash || replay.delivery_id !== String(deliveryId) ||
            String(replay.courier_id) !== String(effectiveActor.id)) throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
          return { collectionId: replay.id, delivery: toDeliveryView({ ...current, actor: effectiveActor }), idempotentReplay: true };
        }
        if (delivery.version !== expectedVersion) throw conflict("DELIVERY_VERSION_CONFLICT");
        if (delivery.delivery_status !== "in_transit" || delivery.closed_at) throw conflict("DELIVERY_TRANSITION_INVALID");
        if (Number(order.status == null ? delivery.preparation_status : order.status) !== 3) throw conflict("DELIVERY_PREPARATION_NOT_FINISHED");
        assertDeliveryCollectionAllowed(order);
        const before = toDeliveryView({ ...current, actor: effectiveActor });
        const amountCents = assertCents(before.remainingDueCents);
        // The authoritative legacy payments.amount_cents is signed INT.
        if (amountCents > 2147483647) throw new DomainError(422, "DELIVERY_MONEY_INVALID", "Amount exceeds commercial payment capacity");
        if (amountCents === 0) throw conflict();
        const now = clock ? explicitTime(await clock({ connection })) : await repo.postingTime({ connection });
        const fields = buildCashRegisterCollectionFields(method === "cash" ? "cash" : "card");
        await repo.settle({ current, fields, connection });
        const paymentId = await repo.appendPayment({ connection, payment: {
          order_id: delivery.origin_order_id, shop_id: effectiveActor.shopId,
          // Required legacy column: a manual reference, never a Stripe intent.
          stripe_payment_intent_id: `manual_delivery:${delivery.id}:${delivery.version + 1}`,
          amount: fromCents(amountCents), amount_cents: amountCents, application_fee_amount: 0,
          currency: "eur", status: "succeeded", payment_method: fields.payment, created: now,
        } });
        // Insert our row before the current payment-range read: independent shops
        // must not each lock the same missing range then wait on insert intention.
        // Any provider conflict rolls this provisional commercial write back.
        await repo.assertNoProviderPayment({ shopId: effectiveActor.shopId, orderId: delivery.origin_order_id, paymentId, connection });
        const summary = { method, amountCents, paymentId, courierId: effectiveActor.id };
        const collectionId = await repo.appendCollection({ connection, collection: {
          shopid: effectiveActor.shopId, delivery_id: delivery.id, courier_id: effectiveActor.id, payment_id: paymentId,
          method, amount_cents: amountCents, idempotency_key: idempotencyKey, request_hash: requestHash,
          result: JSON.stringify(summary), created_at: now,
        } });
        delivery.version += 1;
        await repo.saveVersion({ delivery, now, connection });
        await repo.appendEvent({ connection, event: {
          shopid: effectiveActor.shopId, delivery_id: delivery.id, version: delivery.version, event_type: "collectPayment",
          actor_subject: effectiveActor.subject, actor_id: String(effectiveActor.id),
          previous_state: JSON.stringify({ paymentStatus: order.payment_status }),
          next_state: JSON.stringify({ paymentStatus: fields.payment_status, collectionId, ...summary }),
          idempotency_key: idempotencyKey, request_hash: requestHash,
          result: JSON.stringify({ collectionId, ...summary }), created_at: now,
        } });
        return { collectionId, delivery: toDeliveryView({ delivery, order: { ...order, ...fields }, actor: effectiveActor }), idempotentReplay: false };
      });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") throw conflict("DELIVERY_IDEMPOTENCY_CONFLICT");
      throw error;
    }
  };
  return { collect };
};
module.exports = { buildDeliveryCollections };
