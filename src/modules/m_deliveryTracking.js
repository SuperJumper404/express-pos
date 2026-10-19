const crypto = require("crypto");
const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { withTransaction } = require("../helpers/withTransaction");
const { createTrackingToken, hashTrackingToken } = require("../helpers/deliveryTrackingToken");
const { isDeliveryOperator } = require("../helpers/deliveryAuthorization");
const { resolveDeliveryOrder } = require("./m_deliveryOrders");
const { toCents } = require("../helpers/deliveryMoney");

const json = value => typeof value === "string" ? JSON.parse(value) : value;
const time = value => new Date(typeof value === "string" && /^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(" ", "T")}Z` : value).getTime();
const sqlDate = value => new Date(value).toISOString().slice(0, 19).replace("T", " ");
const notFound = () => new DomainError(404, "DELIVERY_NOT_FOUND", "Delivery not found");
const query = async (connection, sql, values = []) => (await (connection || pool).query(sql, values))[0];
const trustedDeliveryStaff = req => {
  const user = req.currentUser;
  return Boolean(req.sessionSubject === "staff" && user && req.id != null && req.shopid != null &&
    String(user.id) === String(req.id) && String(user.shopid) === String(req.shopid) &&
    Number(user.status) === 1 && user.access != null && [0, 1, 4, 5].includes(Number(user.access)));
};
const isNewDelivery = row => row && (row.delivery_id != null || row.fulfillment_type === "delivery");
const repository = {
  transaction: withTransaction,
  byHash: async (hash, connection) => (await query(connection, "SELECT CAST(id AS CHAR) id,shopid FROM deliveries WHERE tracking_token_hash=?", [hash]))[0],
  identity: async (id, connection) => (await query(connection, "SELECT shopid FROM deliveries WHERE id=?", [id]))[0],
  lockShop: (shopId, connection) => query(connection, "SELECT id FROM shop WHERE id=? FOR UPDATE", [shopId]),
  resolve: resolveDeliveryOrder,
  secrets: async (id, shopId, connection, lock) => (await query(connection,
    `SELECT client_order_token,confirmation_secret_hash,tracking_token_hash FROM deliveries WHERE shopid=? AND id=?${lock ? " FOR UPDATE" : ""}`, [shopId, id]))[0],
  anchors: (id, shopId, connection, lock) => query(connection,
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(result,'$.privacyClosedAt')) privacyClosedAt FROM delivery_events WHERE shopid=? AND delivery_id=? AND event_type='correctTerminal'${lock ? " FOR UPDATE" : ""}`, [shopId, id]),
  dates: async (id, shopId, connection, lock) => (await query(connection,
    `SELECT DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%sZ') created_at,
      DATE_FORMAT(closed_at,'%Y-%m-%dT%H:%i:%sZ') closed_at,
      DATE_FORMAT(tracking_expires_at,'%Y-%m-%dT%H:%i:%sZ') tracking_expires_at
      FROM deliveries WHERE shopid=? AND id=?${lock ? " FOR UPDATE" : ""}`, [shopId, id]))[0],
  restaurant: async (shopId, connection) => (await query(connection, "SELECT shop_name,shop_phone,shop_adress FROM shop WHERE id=?", [shopId]))[0],
  staff: async (actor, connection) => (await query(connection, "SELECT id,shopid,access,status,module_permissions FROM users WHERE shopid=? AND id=? FOR UPDATE", [actor.shopId, actor.id]))[0],
  event: async (shopId, key, connection) => (await query(connection, "SELECT CAST(delivery_id AS CHAR) deliveryId,request_hash FROM delivery_events WHERE shopid=? AND idempotency_key=? FOR UPDATE", [shopId, key]))[0],
  rotate: async ({ delivery, hash, expiry, event, connection }) => {
    await query(connection, "UPDATE deliveries SET tracking_token_hash=?,tracking_expires_at=?,version=version+1 WHERE shopid=? AND id=?", [hash, sqlDate(expiry), delivery.shopid, delivery.id]);
    await query(connection, "INSERT INTO delivery_events SET ?", [event]);
  },
};
const ceiling = async (repo, delivery, connection, lock = false) => {
  // SQL DATETIME is server UTC, independent of the legacy driver's local timezone.
  const dates = await repo.dates(delivery.id, delivery.shopid, connection, lock);
  if (!dates) throw notFound();
  const values = [time(dates.created_at) + 30 * 86400000, time(dates.tracking_expires_at)];
  if (dates.closed_at) values.push(time(dates.closed_at) + 7 * 86400000);
  for (const anchor of await repo.anchors(delivery.id, delivery.shopid, connection, lock)) {
    // Missing/corrupt immutable correction evidence cannot reopen public access.
    values.push(time(anchor.privacyClosedAt || "invalid") + 7 * 86400000);
  }
  const expiry = Math.min(...values);
  if (!Number.isFinite(expiry)) throw notFound();
  return expiry;
};
const stage = (delivery, order) => {
  if (["issue", "failed", "canceled"].includes(delivery.delivery_status)) return "restaurant_intervention";
  if (delivery.delivery_status === "delivered") return "delivered";
  if (delivery.delivery_status === "in_transit") return "in_delivery";
  return Number(order.status) === 3 ? "ready" : Number(order.status) === 2 ? "preparing" : "received";
};

const buildDeliveryTracking = ({ repository: repo = repository, clock = () => new Date(), tokenCodec = { create: createTrackingToken, hash: hashTrackingToken },
  addressViews = require("../services/deliveryAddressViews").buildDeliveryAddressViews() } = {}) => ({
  read: async ({ token }) => {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound();
    let postalContext;
    const view = await repo.transaction(async connection => {
      const identity = await repo.byHash(tokenCodec.hash(token), connection);
      if (!identity) throw notFound();
      const resolved = await repo.resolve({ shopId: identity.shopid, deliveryId: identity.id, connection });
      if (!resolved) throw notFound();
      const { delivery, order } = resolved;
      if (time(clock()) >= await ceiling(repo, delivery, connection)) throw notFound();
      const shop = await repo.restaurant(delivery.shopid, connection);
      if (!shop) throw notFound();
      const address = json(delivery.address_snapshot);
      if (address.provider === "google_places") postalContext = { shopId: delivery.shopid, addressSnapshot: address };
      const total = toCents(order.subtotal);
      return {
        reference: delivery.order_reference, stage: stage(delivery, order),
        restaurant: { name: shop.shop_name, phone: shop.shop_phone, address: shop.shop_adress },
        addressSnapshot: { street: address.street || address.line1 || "", postalCode: address.postalCode || "", city: address.city || "", country: address.country || "" },
        payment: { status: order.payment_status, totalCents: total, remainingDueCents: ["paid", "refunded"].includes(order.payment_status) ? 0 : total },
      };
    });
    if (postalContext) {
      const display = await addressViews.hydrate(postalContext);
      view.addressSnapshot = Object.fromEntries(["street", "postalCode", "city", "country"].map(key => [key, display.addressSnapshot[key] || ""]));
      view.addressProvider = "google_places";
      view.addressDisplayStatus = display.displayStatus;
    }
    return view;
  },
  rotate: async ({ actor, privateCheckoutContext, deliveryId, idempotencyKey }) => {
    if (typeof deliveryId !== "string" || !/^[1-9]\d{0,19}$/.test(deliveryId) ||
      typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) throw notFound();
    return repo.transaction(async connection => {
      const identity = await repo.identity(deliveryId, connection);
      if (!identity) throw notFound();
      await repo.lockShop(identity.shopid, connection);
      const resolved = await repo.resolve({ shopId: identity.shopid, deliveryId, connection, forUpdate: true });
      if (!resolved) throw notFound();
      const { delivery } = resolved;
      const secrets = await repo.secrets(deliveryId, delivery.shopid, connection, true);
      let author;
      if (actor && actor.subject === "staff" && String(actor.shopId) === String(delivery.shopid)) {
        const account = await repo.staff(actor, connection);
        if (account && account.access != null && Number(account.status) === 1 && isDeliveryOperator({ ...actor, access: account.access, module_permissions: account.module_permissions })) author = { subject: "staff", id: String(account.id) };
      } else if (actor && actor.subject === "customer" && actor.verifiedSession === true &&
        String(actor.shopId) === String(delivery.shopid) && delivery.customer_account_id != null && String(actor.id) === String(delivery.customer_account_id)) {
        author = { subject: "customer", id: String(actor.id) };
      } else if (!actor && privateCheckoutContext && typeof privateCheckoutContext.confirmationSecret === "string" &&
        /^[A-Za-z0-9_-]{43,128}$/.test(privateCheckoutContext.confirmationSecret) &&
        privateCheckoutContext.clientOrderToken === secrets.client_order_token) {
        const actual = Buffer.from(tokenCodec.hash(privateCheckoutContext.confirmationSecret), "hex");
        const expected = Buffer.from(secrets.confirmation_secret_hash, "hex");
        if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) author = { subject: "service_point", id: null };
      }
      if (!author) throw notFound();
      const expiry = await ceiling(repo, delivery, connection, true);
      if (time(clock()) >= expiry) throw notFound();
      const key = `tracking_rotated:${idempotencyKey}`;
      const requestHash = hashTrackingToken(JSON.stringify([deliveryId, author.subject, author.id, privateCheckoutContext ? secrets.confirmation_secret_hash : null]));
      const replay = await repo.event(delivery.shopid, key, connection);
      if (replay) {
        if (replay.deliveryId !== deliveryId || replay.request_hash !== requestHash) throw new DomainError(409, "DELIVERY_IDEMPOTENCY_CONFLICT", "Tracking action conflicts");
        return { trackingUrl: null, idempotentReplay: true };
      }
      const raw = tokenCodec.create();
      const state = { deliveryStatus: delivery.delivery_status, courierId: delivery.courier_id, closedAt: delivery.closed_at };
      await repo.rotate({ delivery, hash: tokenCodec.hash(raw), expiry, connection, event: {
        shopid: delivery.shopid, delivery_id: deliveryId, version: delivery.version + 1, event_type: "tracking_rotated",
        actor_subject: author.subject, actor_id: author.id, previous_state: JSON.stringify(state), next_state: JSON.stringify(state),
        idempotency_key: key, request_hash: requestHash, result: JSON.stringify({ rotated: true }), created_at: sqlDate(clock()),
      } });
      return { trackingUrl: `/livraison/suivi#${raw}` };
    });
  },
});
module.exports = { buildDeliveryTracking, trustedDeliveryStaff, isNewDelivery };
