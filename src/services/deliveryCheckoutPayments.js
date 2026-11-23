const { randomUUID } = require("crypto");
const DomainError = require("../helpers/domainError");
const { withTransaction } = require("../helpers/withTransaction");
const { toCents, fromCents } = require("../helpers/deliveryMoney");
const { assertDeliveryCollectionAllowed } = require("../helpers/cashRegisterPayment");
const { assertNoActiveTerminalPayment } = require("../helpers/terminalOrderPayment");
const { assertDeliveryOwner, isCourier, forbidden } = require("../helpers/deliveryAuthorization");
const { calculateApplicationFee } = require("../helpers/stripePayment");
const { resolveStripePaymentMethod } = require("../helpers/stripePaymentMethod");
const { resolveDeliveryOrder } = require("../modules/m_deliveryOrders");
const { getStripe } = require("../config/stripe");

const PROVIDER = "stripe_delivery_checkout";
const SOURCE = "delivery_checkout";
const requestOptions = { timeout: 8000, maxNetworkRetries: 0 };
const query = async (connection, sql, values) => (await connection.query(sql, values))[0];
const findWebhookSession = async ({ sessionId, shopId, deliveryId }) => {
  const pool = require("../config/dbPool");
  const filter = sessionId ? "stripe_session_id=?" : "shopid=? AND delivery_id=?";
  return (await query(pool, `SELECT shopid, stripe_session_id, CAST(delivery_id AS CHAR) AS delivery_id
    FROM delivery_checkout_sessions WHERE ${filter}`, sessionId ? [sessionId] : [shopId, deliveryId]))[0];
};
const conflict = () => new DomainError(409, "DELIVERY_PAYMENT_NOT_SETTLED", "Vérifiez le paiement en cours avant de changer de moyen de paiement.");
const unavailable = () => new DomainError(503, "DELIVERY_ONLINE_PAYMENT_UNAVAILABLE", "Le paiement par QR code est temporairement indisponible.");

const configuredReturnUrl = () => {
  try {
    const configured = process.env.DELIVERY_PAYMENT_RETURN_URL;
    const url = configured ? new URL(configured) : new URL("/livraison/paiement-confirme", process.env.STRIPE_CONNECT_RETURN_URL);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol === "https:" || local ? url.href : null;
  } catch {
    return null;
  }
};

const checkoutParams = ({ shop, order, delivery, amountCents, fee, returnUrl, now }) => ({
  mode: "payment",
  locale: "fr",
  success_url: returnUrl,
  expires_at: Math.floor(now / 1000) + 1860,
  adaptive_pricing: { enabled: false },
  payment_method_types: ["card"],
  line_items: [{ quantity: 1, price_data: {
    currency: "eur", unit_amount: amountCents, product_data: { name: "Commande en livraison" },
  } }],
  payment_intent_data: {
    application_fee_amount: fee || undefined,
    on_behalf_of: shop.stripe_account_id,
    transfer_data: { destination: shop.stripe_account_id },
    metadata: { source: SOURCE, shop_id: String(shop.id), order_id: String(order.id), delivery_id: delivery.id },
  },
  metadata: { source: SOURCE },
});

const buildDeliveryCheckoutPayments = ({
  run = withTransaction, resolve = resolveDeliveryOrder, stripe = getStripe, findSession = findWebhookSession,
  returnUrl = configuredReturnUrl, clock = Date.now,
  loyalty = require("../modules/m_loyalty").buildLoyalty(),
} = {}) => {
  const lockShop = async (shopId, connection) => (await query(connection,
    "SELECT id,stripe_account_id,stripe_charges_enabled,stripe_commission_percent FROM shop WHERE id=? FOR UPDATE", [shopId]))[0];
  const readSession = async (shopId, deliveryId, connection) => (await query(connection,
    "SELECT * FROM delivery_checkout_sessions WHERE shopid=? AND delivery_id=? FOR UPDATE", [shopId, deliveryId]))[0];
  const retrieve = (stripeSessionId) => stripe().checkout.sessions.retrieve(
    stripeSessionId, { expand: ["payment_intent.latest_charge"] }, requestOptions,
  );

  const reconcile = async ({ delivery, order }, row, session, connection) => {
    if (session.id !== row.stripe_session_id || session.metadata?.source !== SOURCE ||
      session.currency !== "eur" || session.amount_total !== row.amount_cents ||
      order.payment_provider !== PROVIDER || order.payment_status !== "requires_payment") throw conflict();
    const intent = session.payment_intent;
    const paid = intent?.status === "succeeded";
    if (!paid && session.status === "open" && session.payment_status === "unpaid") {
      if (!session.url) throw unavailable();
      return { status: "pending", url: session.url, attemptId: session.id, expiresAt: session.expires_at };
    }
    if (!paid && (session.status !== "expired" || session.payment_status !== "unpaid")) {
      return { status: "processing", attemptId: session.id };
    }

    let fields = { payment_provider: null, payment_status: "unpaid" };
    if (paid) {
      if (intent.amount_received !== row.amount_cents ||
        intent.currency !== "eur" || intent.metadata?.source !== SOURCE ||
        intent.metadata.shop_id !== String(delivery.shopid) || intent.metadata.order_id !== String(order.id) ||
        intent.metadata.delivery_id !== delivery.id ||
        intent.transfer_data?.destination !== row.stripe_account_id ||
        Number(intent.application_fee_amount || 0) !== row.application_fee_cents ||
        toCents(order.subtotal) !== row.amount_cents) throw conflict();
      const charge = intent.latest_charge;
      if (!charge?.id) throw unavailable();
      const payment = resolveStripePaymentMethod({ paymentIntent: intent, charge });
      fields = { payment_provider: "stripe", payment_status: "paid", stripe_payment_intent_id: intent.id, payment };
      await query(connection, "INSERT INTO payments SET ?", [{
        order_id: order.id, shop_id: delivery.shopid, stripe_payment_intent_id: intent.id,
        stripe_charge_id: charge.id, amount: fromCents(row.amount_cents), amount_cents: row.amount_cents,
        application_fee_amount: row.application_fee_cents, currency: "eur",
        status: "succeeded", payment_method: payment, created: new Date(clock()),
      }]);
    }
    const result = await query(connection, "UPDATE orders SET ? WHERE shopid=? AND id=? AND payment_provider=? AND payment_status='requires_payment'",
      [fields, delivery.shopid, order.id, PROVIDER]);
    if (result.affectedRows !== 1) throw conflict();
    if (paid && loyalty) await loyalty.settlePaidOrder({ connection, shopId: Number(delivery.shopid),
      orderId: order.id, paymentKey: `stripe:${fields.stripe_payment_intent_id}`, paidCents: row.amount_cents });
    await query(connection, "DELETE FROM delivery_checkout_sessions WHERE shopid=? AND delivery_id=?",
      [delivery.shopid, delivery.id]);
    return { status: paid ? "paid" : "idle" };
  };

  const withCourierOrder = ({ actor, deliveryId }, work) => run(async connection => {
    if (!isCourier(actor)) throw forbidden();
    const shop = await lockShop(actor.shopId, connection);
    if (!shop) throw forbidden();
    const current = await resolve({ shopId: actor.shopId, deliveryId, connection, forUpdate: true });
    if (!current) throw new DomainError(404, "DELIVERY_NOT_FOUND", "Livraison introuvable.");
    const { order, delivery } = current;
    assertDeliveryOwner(actor, delivery);
    const [account] = await query(connection, "SELECT id FROM users WHERE shopid=? AND id=? AND status=1 AND access=6 FOR UPDATE",
      [shop.id, actor.id]);
    if (!account) throw forbidden();
    return work({ shop, current, order, delivery, connection });
  });

  const startSession = async ({ shop, current, order, delivery, connection }, expectedVersion) => {
    if (current.orderKind !== "active" || delivery.delivery_status !== "in_transit" || delivery.closed_at ||
      Number(order.status) !== 3 || expectedVersion !== delivery.version) throw conflict();
    assertDeliveryCollectionAllowed(order);
    await assertNoActiveTerminalPayment({ connection, shopId: shop.id, orderId: order.id });
    const amountCents = toCents(order.subtotal);
    if (amountCents < 50 || amountCents > 99999999) throw new DomainError(422, "DELIVERY_ONLINE_PAYMENT_AMOUNT", "Le montant ne peut pas être encaissé par QR code.");
    const url = returnUrl();
    if (!url || !shop.stripe_account_id || Number(shop.stripe_charges_enabled) !== 1) throw unavailable();
    const fee = calculateApplicationFee(amountCents, shop.stripe_commission_percent);
    const session = await stripe().checkout.sessions.create(
      checkoutParams({ shop, order, delivery, amountCents, fee, returnUrl: url, now: clock() }),
      { ...requestOptions, idempotencyKey: `delivery-checkout:${randomUUID()}` },
    );
    if (!session?.id || !session.url || session.status !== "open") throw unavailable();
    await query(connection, "INSERT INTO delivery_checkout_sessions SET ?", [{
      shopid: shop.id, delivery_id: delivery.id, stripe_session_id: session.id,
      amount_cents: amountCents, application_fee_cents: fee, stripe_account_id: shop.stripe_account_id,
    }]);
    const result = await query(connection, "UPDATE orders SET payment_provider=?,payment_status='requires_payment' WHERE shopid=? AND id=? AND payment_status='unpaid'",
      [PROVIDER, shop.id, order.id]);
    if (result.affectedRows !== 1) throw conflict();
    return { status: "pending", url: session.url, attemptId: session.id, expiresAt: session.expires_at };
  };

  const courier = async (input) => {
    const { deliveryId, action, expectedVersion, attemptId } = input;
    const prepared = await withCourierOrder(input, async scope => {
      if (scope.order.payment_status === "paid") return { status: "paid" };
      const row = await readSession(scope.shop.id, deliveryId, scope.connection);
      if (row) return { existingSessionId: row.stripe_session_id };
      return action === "start" ? startSession(scope, expectedVersion) : { status: "idle" };
    });
    if (!prepared.existingSessionId) return prepared;

    // The active row remains reserved during provider calls, without blocking
    // other orders in the restaurant while Stripe answers.
    let session = await retrieve(prepared.existingSessionId);
    if (action === "cancel" && session.id === attemptId && session.status === "open" && session.payment_intent?.status !== "succeeded") {
      try { await stripe().checkout.sessions.expire(session.id, {}, requestOptions); }
      catch (error) {
        if (error.type !== "StripeInvalidRequestError") throw error;
      }
      session = await retrieve(session.id);
    }
    return withCourierOrder(input, async ({ shop, current, order, connection }) => {
      if (order.payment_status === "paid") return { status: "paid" };
      const row = await readSession(shop.id, deliveryId, connection);
      if (!row) return { status: "idle" };
      if (row.stripe_session_id !== session.id) return { status: "processing", attemptId: row.stripe_session_id };
      return reconcile(current, row, session, connection);
    });
  };

  const webhook = async event => {
    const object = event.data?.object;
    if (object?.metadata?.source !== SOURCE) return null;
    const intentEvent = event.type.startsWith("payment_intent.");
    if (intentEvent && event.type !== "payment_intent.succeeded") return { handled: true };
    if (!intentEvent && !["checkout.session.completed", "checkout.session.expired"].includes(event.type)) return null;
    const { shop_id: shopId, delivery_id: deliveryId } = object.metadata;
    if (intentEvent && (!/^[1-9]\d*$/.test(shopId || "") || !/^[1-9]\d{0,19}$/.test(deliveryId || ""))) return { handled: true };
    const row = await findSession(intentEvent ? { shopId, deliveryId } : { sessionId: object.id });
    if (!row) return { handled: true };
    const session = await retrieve(row.stripe_session_id);
    if (intentEvent && session.payment_intent?.id !== object.id) return { handled: true };
    return run(async connection => {
      await lockShop(row.shopid, connection);
      const current = await resolve({ shopId: row.shopid, deliveryId: row.delivery_id, connection, forUpdate: true });
      const locked = await readSession(row.shopid, row.delivery_id, connection);
      if (current && locked?.stripe_session_id === row.stripe_session_id) {
        await reconcile(current, locked, session, connection);
      }
      return { handled: true };
    });
  };
  return { courier, webhook };
};

module.exports = { buildDeliveryCheckoutPayments, checkoutParams };
