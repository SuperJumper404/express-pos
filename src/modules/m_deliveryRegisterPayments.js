const DomainError = require("../helpers/domainError");
const { toCents, fromCents } = require("../helpers/deliveryMoney");
const { isOrderTakerAccess } = require("../helpers/staffAccess");
const { forbidden } = require("../helpers/deliveryAuthorization");
const { normalizePaymentMethod } = require("../helpers/paymentMethod");
const { toDeliveryView } = require("./m_deliveryOrders");

const query = async (connection, sql, values = []) => (await connection.query(sql, values))[0];
const conflict = () => new DomainError(409, "DELIVERY_PAYMENT_NOT_SETTLED", "Delivery payment source conflicts with current state");
const registerMethod = value => {
  const key = String(value || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ");
  if (["cash", "espece", "especes"].includes(key)) return "cash";
  if (["card", "carte", "carte bancaire", "cb", "carte bleu", "credit card"].includes(key)) return "external_card";
  if (["cheque", "cheques"].includes(key)) return "cheque";
  if (["ticket", "ticket resto", "ticket restaurant", "tickets resto", "tickets restaurants", "tickets restaurant"].includes(key)) return "meal_voucher";
  throw new DomainError(422, "DELIVERY_PAYMENT_METHOD_INVALID", "Unsupported manual delivery payment method");
};

// Called only within the commercial producer's shop-locked transaction.
const recordRegisterSettlement = async ({ current, operatorId, paymentMethod, connection }) => {
  if (!connection) throw new Error("Register settlement requires the commercial transaction");
  const { delivery, order } = current;
  const [account] = await query(connection, "SELECT id,shopid,access,status FROM users WHERE shopid=? AND id=? FOR UPDATE", [delivery.shopid, operatorId]);
  if (!account || account.access == null || Number(account.status) !== 1 || !isOrderTakerAccess(account.access)) throw forbidden();
  const method = registerMethod(paymentMethod);
  const amountCents = toCents(toDeliveryView(current).financials.grand_total);
  if (amountCents <= 0 || amountCents > 2147483647) throw conflict();
  const existing = await query(connection, "SELECT id FROM payments FORCE INDEX (order_id) WHERE shop_id=? AND order_id=? AND status<>'canceled' FOR UPDATE", [delivery.shopid, delivery.origin_order_id]);
  const terminal = await query(connection, `SELECT p.id FROM stripe_terminal_payment_orders a JOIN stripe_terminal_payments p
    ON p.shopid=a.shopid AND p.id=a.terminal_payment_id WHERE a.shopid=? AND a.order_id=? AND p.status IN ('creating','processing') FOR UPDATE`, [delivery.shopid, delivery.origin_order_id]);
  if (existing.length || terminal.length || order.stripe_payment_intent_id || order.stripe_terminal_payment_id) throw conflict();
  const now = (await query(connection, "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') now"))[0].now;
  const label = normalizePaymentMethod(paymentMethod);
  await query(connection, "INSERT INTO payments SET ?", [{ shop_id: delivery.shopid, order_id: delivery.origin_order_id,
    stripe_payment_intent_id: `manual_register_delivery:${delivery.id}`, amount: fromCents(amountCents), amount_cents: amountCents,
    application_fee_amount: 0, currency: "eur", status: "succeeded", payment_method: label, created: now }]);
  const paymentId = (await query(connection, "SELECT LAST_INSERT_ID() id"))[0].id;
  await query(connection, "INSERT INTO delivery_register_payments SET ?", [{ shopid: delivery.shopid, delivery_id: delivery.id,
    payment_id: paymentId, operator_id: account.id, method, payment_label: label, amount_cents: amountCents, created_at: now }]);
};

const readManualSources = async ({ shopId, deliveryId, connection }) => {
  const courier = await query(connection, `SELECT *,CAST(id AS CHAR) id,CAST(delivery_id AS CHAR) delivery_id,
    'courier' payment_origin FROM delivery_payment_collections WHERE shopid=? AND delivery_id=? FOR UPDATE`, [shopId, deliveryId]);
  const register = await query(connection, `SELECT *,CAST(id AS CHAR) id,CAST(delivery_id AS CHAR) delivery_id,
    'register' payment_origin FROM delivery_register_payments WHERE shopid=? AND delivery_id=? FOR UPDATE`, [shopId, deliveryId]);
  return [...courier, ...register];
};
const manualRefundEligible = ({ current, source, payment }) => {
  if (!source || !payment) return false;
  const { delivery, order } = current;
  const amount = Number(source.amount_cents);
  const register = source.payment_origin === "register";
  return Number.isSafeInteger(amount) && amount > 0 && amount === toCents(toDeliveryView(current).financials.grand_total) &&
    order.payment_status === "paid" && (register ? [null, "counter"].includes(order.payment_provider || null) : !order.payment_provider) &&
    !order.stripe_payment_intent_id && !order.stripe_terminal_payment_id && Number(payment.order_id) === Number(delivery.origin_order_id) &&
    payment.status === "succeeded" && Number(payment.amount_cents) === amount && payment.currency === "eur" &&
    !payment.stripe_charge_id && !payment.stripe_refund_id && !payment.refund_status &&
    (register ? ["cash", "external_card", "cheque", "meal_voucher"].includes(source.method) &&
      payment.stripe_payment_intent_id === `manual_register_delivery:${delivery.id}` && source.payment_label === order.payment && source.payment_label === payment.payment_method
      : ["cash", "external_card"].includes(source.method) && new RegExp(`^manual_delivery:${delivery.id}:\\d+$`).test(payment.stripe_payment_intent_id));
};
module.exports = { registerMethod, recordRegisterSettlement, readManualSources, manualRefundEligible };
