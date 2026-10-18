const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { toCents, fromCents, assertCents } = require("../helpers/deliveryMoney");
const { createTrackingToken, hashTrackingToken } = require("../helpers/deliveryTrackingToken");
const { isOrderTakerAccess } = require("../helpers/staffAccess");
const { isCourier, isDeliveryOperator, assertDeliveryOwner } = require("../helpers/deliveryAuthorization");

const json = value => typeof value === "string" ? JSON.parse(value) : value;
const date = value => new Date(value).toISOString().slice(0, 19).replace("T", " ");
const query = async (connection, sql, values = []) => (await (connection || pool).query(sql, values))[0];
const requireConnection = connection => {
  if (!connection) throw new Error("Delivery mutation requires the caller's transaction");
};
const projection = `CAST(d.id AS CHAR) AS id, d.shopid, d.origin_order_id, d.order_reference,
  CAST(d.customer_account_id AS CHAR) AS customer_account_id, d.delivery_status, d.version, d.courier_id,
  d.address_snapshot, d.contact_snapshot, d.latitude, d.longitude, d.distance_meters,
  d.settings_revision, d.charge_revision, d.preparation_status, d.client_order_token,
  d.tracking_expires_at, d.closed_at, d.created_at, d.updated_at`;
const orderProjection = `id, shopid, ordernumber, subtotal, subtotal_before_discount,
  discount_amount, discount_type, discount_value, payment_status, payment_provider, status,
  payment, stripe_payment_intent_id, stripe_terminal_payment_id, finished,
  customerID, CAST(delivery_id AS CHAR) AS delivery_id, CAST(customer_account_id AS CHAR) AS customer_account_id,
  fulfillment_type, order_source`;

// Payment references always use the original order ID, never the archive PK.
// Lock commercial rows before the dossier, compatible with edits and Terminal.
const resolveCommercialOrder = async ({ shopId, orderId, connection, forUpdate = false }) => {
  if (forUpdate) requireConnection(connection);
  const lock = forUpdate ? " FOR UPDATE" : "";
  const shopClause = shopId == null ? "" : " AND shopid = ?";
  const values = shopId == null ? [orderId] : [orderId, shopId];
  const [active] = await query(connection, `SELECT orders.*, CAST(delivery_id AS CHAR) AS delivery_id,
    CAST(customer_account_id AS CHAR) AS customer_account_id FROM orders WHERE id = ?${shopClause} LIMIT 1${lock}`, values);
  if (active || shopId == null) return active || null;
  const [link] = await query(connection, "SELECT CAST(id AS CHAR) AS id FROM deliveries WHERE shopid = ? AND origin_order_id = ?", [shopId, orderId]);
  if (!link) return null;
  const [archive] = await query(connection, `SELECT archives.*, CAST(delivery_id AS CHAR) AS delivery_id,
    CAST(customer_account_id AS CHAR) AS customer_account_id FROM archives WHERE shopid = ? AND delivery_id = ? LIMIT 1${lock}`, [shopId, link.id]);
  return archive ? { ...archive, id: orderId, archive_id: archive.id } : null;
};

const financialsFor = (delivery, order) => {
  const charge = delivery.charge;
  const items = toCents(order.subtotal_before_discount);
  const discount = toCents(order.discount_amount || 0);
  const total = toCents(order.subtotal);
  if (discount > items || assertCents(items - discount + charge.feeCents) !== total) {
    throw new DomainError(409, "DELIVERY_TOTAL_MISMATCH", "Delivery financial snapshot is inconsistent");
  }
  return {
    items_total: fromCents(items), items_discount: fromCents(discount),
    delivery_fee: fromCents(charge.feeCents), grand_total: fromCents(total),
    delivery_charge: charge,
  };
};
const toDeliveryView = ({ delivery, order, actor }) => {
  const courier = isCourier(actor);
  if (courier) assertDeliveryOwner(actor, delivery);
  const pending = !["paid", "refunded", "unpaid"].includes(order.payment_status) ||
    (order.payment_status === "unpaid" && order.payment_provider === "stripe");
  const staff = isDeliveryOperator(actor) && String(actor.shopId) === String(delivery.shopid);
  const closed = ["delivered", "failed", "canceled"].includes(delivery.delivery_status) || Boolean(delivery.closed_at);
  const due = order.payment_status === "paid" || order.payment_status === "refunded" ? 0 : toCents(order.subtotal);
  const preparation = order.status == null ? delivery.preparation_status : order.status;
  const actions = [];
  if (!pending && !closed) {
    if (staff) {
      if (["unassigned", "assigned"].includes(delivery.delivery_status)) actions.push("assign");
      if (delivery.delivery_status === "issue") actions.push("resolveIssue");
      if (["assigned", "in_transit"].includes(delivery.delivery_status)) actions.push("reportIssue");
    }
    if (courier) {
      if (delivery.delivery_status === "assigned" && Number(preparation) === 3) actions.push("pickup");
      if (delivery.delivery_status === "in_transit" && due === 0) actions.push("deliver");
      if (delivery.delivery_status === "in_transit" && Number(preparation) === 3 && due > 0 &&
        order.payment_status === "unpaid" && order.payment_provider == null &&
        order.stripe_payment_intent_id == null && order.stripe_terminal_payment_id == null) actions.push("collectPayment");
      if (["assigned", "in_transit"].includes(delivery.delivery_status)) actions.push("reportIssue");
    }
  }
  return {
    id: String(delivery.id), version: delivery.version, shopId: delivery.shopid,
    orderReference: delivery.order_reference, preparationStatus: preparation,
    paymentStatus: order.payment_status, deliveryStatus: delivery.delivery_status, courierId: delivery.courier_id,
    acceptanceStatus: pending ? "payment_pending" : "accepted",
    remainingDueCents: due,
    ...(!courier || !closed ? { addressSnapshot: json(delivery.address_snapshot),
      contactSnapshot: json(delivery.contact_snapshot), ...(order.items ? { items: order.items } : {}) } : {}),
    financials: financialsFor(delivery, order),
    allowedActions: actions,
  };
};

const buildDeliveryOrders = ({ clock = () => new Date(), randomToken = createTrackingToken } = {}) => {
  const findCheckoutReplay = async ({ shopId, token, requestHash, connection }) => {
    const rows = await query(connection, `SELECT e.request_hash, e.result FROM deliveries d
      JOIN delivery_events e ON e.shopid = d.shopid AND e.delivery_id = d.id AND e.event_type = 'checkout_created'
      WHERE d.shopid = ? AND d.client_order_token = ? LIMIT 1`, [shopId, token]);
    if (!rows.length) return null;
    if (rows[0].request_hash !== requestHash) throw new DomainError(409, "DELIVERY_IDEMPOTENCY_CONFLICT", "Checkout token was used for another delivery");
    return { ...json(rows[0].result), idempotent_replay: true };
  };
  const resolveDeliveryOrder = async ({ shopId, deliveryId, connection, forUpdate = false }) => {
    if (!/^[1-9]\d{0,19}$/.test(String(deliveryId))) throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid delivery identifier");
    if (forUpdate) requireConnection(connection);
    const lock = forUpdate ? " FOR UPDATE" : "";
    const [identity] = await query(connection, "SELECT origin_order_id FROM deliveries WHERE shopid = ? AND id = ?", [shopId, deliveryId]);
    if (!identity) return null;
    let [order] = await query(connection, `SELECT ${orderProjection} FROM orders WHERE shopid = ? AND id = ?${lock}`, [shopId, identity.origin_order_id]);
    let orderKind = "active";
    if (!order) {
      [order] = await query(connection, `SELECT ${orderProjection} FROM archives WHERE shopid = ? AND delivery_id = ?${lock}`, [shopId, deliveryId]);
      orderKind = "archive";
    }
    if (!order) throw new DomainError(409, "DELIVERY_ORDER_MISSING", "Delivery commercial order is unavailable");
    const [delivery] = await query(connection, `SELECT ${projection} FROM deliveries d WHERE d.shopid = ? AND d.id = ?${lock}`, [shopId, deliveryId]);
    if (!delivery || String(order.delivery_id) !== String(deliveryId) || delivery.origin_order_id !== identity.origin_order_id) {
      throw new DomainError(409, "DELIVERY_ORDER_MISSING", "Delivery commercial link changed");
    }
    const [charge] = await query(connection, `SELECT CAST(band_fee_cents AS CHAR) AS band_fee_cents,
      free_delivery_applied, CAST(fee_cents AS CHAR) AS fee_cents,
      CAST(total_excl_tax_cents AS CHAR) AS total_excl_tax_cents, CAST(tax_cents AS CHAR) AS tax_cents,
      vat_rate, fiscal_policy FROM delivery_charge_snapshots WHERE shopid = ? AND delivery_id = ? AND revision = ?${lock}`,
    [shopId, deliveryId, delivery.charge_revision]);
    if (!charge) throw new DomainError(409, "DELIVERY_CHARGE_MISSING", "Delivery financial snapshot is unavailable");
    delivery.charge = {
      bandFeeCents: assertCents(Number(charge.band_fee_cents)), freeDeliveryApplied: Boolean(charge.free_delivery_applied),
      feeCents: assertCents(Number(charge.fee_cents)), totalExclTaxCents: assertCents(Number(charge.total_excl_tax_cents)),
      taxCents: assertCents(Number(charge.tax_cents)), vatRate: Number(charge.vat_rate), fiscalPolicy: json(charge.fiscal_policy),
    };
    return { delivery, order, orderKind };
  };
  const archiveDeliveryOrder = async ({ shopId, deliveryId, archiveId, preparationStatus, connection }) => {
    requireConnection(connection);
    const current = await resolveDeliveryOrder({ shopId, deliveryId, connection, forUpdate: true });
    if (!current || Number(preparationStatus) !== 3 || Number(current.order.status) !== 3) {
      throw new DomainError(409, "DELIVERY_PREPARATION_NOT_FINISHED", "Delivery preparation must be finished before archive");
    }
    const [archive] = await query(connection, "SELECT id, payment_status FROM archives WHERE shopid = ? AND id = ? AND delivery_id = ? FOR UPDATE", [shopId, archiveId, deliveryId]);
    if (!archive || !["paid", "refunded"].includes(archive.payment_status)) {
      throw new DomainError(409, "DELIVERY_PAYMENT_NOT_SETTLED", "Delivery payment must be settled before archive");
    }
    await query(connection, "UPDATE deliveries SET preparation_status = ?, updated_at = ? WHERE shopid = ? AND id = ?", [preparationStatus, date(clock()), shopId, deliveryId]);
  };
  const insertCharge = async ({ deliveryId, shopId, revision, quote, connection }) => {
    const charge = quote.chargeSnapshot;
    await query(connection, "INSERT INTO delivery_charge_snapshots SET ?", [{
      shopid: shopId, delivery_id: deliveryId, revision, band_fee_cents: String(charge.bandFeeCents),
      free_delivery_applied: charge.freeDeliveryApplied ? 1 : 0, fee_cents: String(charge.feeCents),
      total_excl_tax_cents: String(charge.totalExclTaxCents), tax_cents: String(charge.taxCents),
      vat_rate: charge.vatRate, fiscal_policy: JSON.stringify(charge.fiscalPolicy), created_at: date(clock()),
    }]);
  };
  const insertEvent = async ({ checkout, deliveryId, version, type, previous, next, result, connection }) => {
    await query(connection, "INSERT INTO delivery_events SET ?", [{
      shopid: checkout.shopId, delivery_id: deliveryId, version, event_type: type,
      actor_subject: checkout.sessionSubject || "staff", actor_id: String(checkout.actorId || checkout.servicePointId),
      previous_state: JSON.stringify(previous), next_state: JSON.stringify(next),
      idempotency_key: `${type}:${checkout.clientOrderToken}`, request_hash: checkout.requestHash,
      result: JSON.stringify(result), created_at: date(clock()),
    }]);
  };
  const createDeliveryForOrder = async ({ checkout, quote, connection }) => {
    requireConnection(connection);
    const rawToken = randomToken();
    const timestamp = date(clock());
    await query(connection, "INSERT INTO deliveries SET ?", [{
      shopid: checkout.shopId, origin_order_id: checkout.orderId, order_reference: checkout.orderReference,
      customer_account_id: null, address_snapshot: JSON.stringify(quote.addressSnapshot),
      contact_snapshot: JSON.stringify({ name: checkout.customer.name, phone: checkout.customer.phone }),
      latitude: quote.addressSnapshot.latitude, longitude: quote.addressSnapshot.longitude,
      distance_meters: quote.distanceMeters, settings_revision: quote.settingsRevision,
      client_order_token: checkout.clientOrderToken,
      confirmation_secret_hash: hashTrackingToken(checkout.deliveryConfirmationSecret),
      tracking_token_hash: hashTrackingToken(rawToken),
      tracking_expires_at: date(new Date(new Date(clock()).getTime() + 30 * 86400000)), created_at: timestamp, updated_at: timestamp,
    }]);
    // LAST_INSERT_ID is cast by SQL: the legacy pool otherwise rounds BIGINT insertId.
    const [{ id: deliveryId }] = await query(connection, "SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
    await query(connection, "UPDATE orders SET delivery_id = ?, fulfillment_type = 'delivery', customer_account_id = NULL WHERE shopid = ? AND id = ?", [deliveryId, checkout.shopId, checkout.orderId]);
    await insertCharge({ deliveryId, shopId: checkout.shopId, revision: 1, quote, connection });
    const resolved = await resolveDeliveryOrder({ shopId: checkout.shopId, deliveryId, connection });
    const view = toDeliveryView({ ...resolved, actor: checkout.actor });
    const result = { ...checkout.result, delivery: view };
    await insertEvent({ checkout, deliveryId, version: 1, type: "checkout_created", previous: {},
      next: { delivery: view, settingsRevision: quote.settingsRevision, chargeRevision: 1, distanceMeters: quote.distanceMeters }, result, connection });
    return { delivery: view, tracking_url: `/livraison/suivi#${rawToken}` };
  };
  const findEditReplay = async ({ shopId, idempotencyKey, requestHash, connection }) => {
    const [event] = await query(connection, "SELECT request_hash, result FROM delivery_events WHERE shopid = ? AND idempotency_key = ?", [shopId, `checkout_revised:${idempotencyKey}`]);
    if (!event) return null;
    if (event.request_hash !== requestHash) throw new DomainError(409, "DELIVERY_IDEMPOTENCY_CONFLICT", "Edit key was used for another request");
    return { ...json(event.result), idempotent_replay: true };
  };
  const assertEditable = ({ delivery, order }) => {
    if (!["unpaid", "requires_payment"].includes(order.payment_status)
      || ![1, 2, 3].includes(Number(order.status)) || !["unassigned", "assigned"].includes(delivery.delivery_status)) {
      throw new DomainError(409, "DELIVERY_EDIT_NOT_ALLOWED", "Only unpaid deliveries before pickup can be revised");
    }
  };
  const reviseDeliveryForOrder = async ({ checkout, previous, quote, result, connection }) => {
    requireConnection(connection);
    assertEditable(previous);
    const { delivery } = previous;
    const { normalizeAddress } = require("../helpers/deliveryAddress");
    const { validCoordinates } = require("../helpers/deliveryPricing");
    const acceptedAddress = json(delivery.address_snapshot);
    const addressSnapshot = { ...quote.addressSnapshot };
    const privateFields = ["complement", "building", "floor", "intercom", "instructions"];
    const postalFields = ["street", "postalCode", "city", "country"];
    let sameDestination = false;
    try {
      const acceptedPostal = normalizeAddress(acceptedAddress);
      const quotedPostal = normalizeAddress(addressSnapshot);
      sameDestination = postalFields.every(key => typeof acceptedAddress[key] === "string" && acceptedAddress[key].trim() &&
        typeof addressSnapshot[key] === "string" && addressSnapshot[key].trim() && acceptedPostal[key] === quotedPostal[key]) &&
        validCoordinates(acceptedAddress) && validCoordinates(addressSnapshot) &&
        acceptedAddress.latitude === addressSnapshot.latitude && acceptedAddress.longitude === addressSnapshot.longitude &&
        ["providerId", "cityCode", "precision"].every(key => acceptedAddress[key] === undefined || acceptedAddress[key] === addressSnapshot[key]);
    } catch (_) { /* An incomplete accepted destination cannot authorize copying access details. */ }
    if (!sameDestination && privateFields.some(key => acceptedAddress && acceptedAddress[key])) {
      throw new DomainError(409, "DELIVERY_ADDRESS_CHANGE_NOT_ALLOWED", "Existing access details require the same verified delivery address");
    }
    // Postal proofs cannot replace private details from the caller's locked accepted snapshot.
    for (const key of privateFields) {
      delete addressSnapshot[key];
      if (sameDestination && Object.prototype.hasOwnProperty.call(acceptedAddress, key)) addressSnapshot[key] = acceptedAddress[key];
    }
    const revision = delivery.charge_revision + 1;
    await insertCharge({ deliveryId: delivery.id, shopId: checkout.shopId, revision, quote, connection });
    const update = await query(connection, `UPDATE deliveries SET address_snapshot = ?, latitude = ?, longitude = ?, distance_meters = ?,
      settings_revision = ?, charge_revision = ?, version = version + 1, updated_at = ?
      WHERE shopid = ? AND id = ? AND version = ?`,
    [JSON.stringify(addressSnapshot), quote.addressSnapshot.latitude, quote.addressSnapshot.longitude,
      quote.distanceMeters, quote.settingsRevision, revision, date(clock()), checkout.shopId, delivery.id, checkout.deliveryExpectedVersion]);
    if (!update.affectedRows) throw new DomainError(409, "DELIVERY_VERSION_CONFLICT", "Delivery changed");
    const next = await resolveDeliveryOrder({ shopId: checkout.shopId, deliveryId: delivery.id, connection });
    const view = toDeliveryView({ ...next, actor: checkout.actor });
    const response = { ...result, delivery: view };
    await insertEvent({ checkout: { ...checkout, clientOrderToken: checkout.deliveryIdempotencyKey }, deliveryId: delivery.id,
      version: next.delivery.version, type: "checkout_revised",
      previous: { delivery: toDeliveryView({ ...previous, actor: checkout.actor }), settingsRevision: delivery.settings_revision, chargeRevision: delivery.charge_revision, distanceMeters: delivery.distance_meters },
      next: { delivery: view, settingsRevision: quote.settingsRevision, chargeRevision: revision, distanceMeters: quote.distanceMeters }, result: response, connection });
    return response;
  };
  return { createDeliveryForOrder, resolveDeliveryOrder, archiveDeliveryOrder, toDeliveryView, findCheckoutReplay, findEditReplay, assertEditable, reviseDeliveryForOrder };
};
const service = buildDeliveryOrders();
module.exports = { buildDeliveryOrders, resolveCommercialOrder, ...service };
