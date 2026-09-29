const crypto = require("crypto");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");
const { normalizePaymentMethod } = require("../helpers/paymentMethod");
const { TERMINAL_PAYMENT_METHOD } = require("../helpers/stripeTerminal");
const {
  isCashRegisterOrderDueAndArchivable,
} = require("../helpers/cashRegisterPayment");

const fail = (status, code, message) => {
  throw new DomainError(status, code, message);
};

const invalid = (field) => fail(
  400,
  "SETTLEMENT_INVALID_INPUT",
  `Invalid settlement field: ${field}`,
);

const isPositiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0
  && typeof value !== "boolean";
const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (value) => Number((value / 100).toFixed(2));

const normalizeOrderIds = (value) => {
  if (!Array.isArray(value) || !value.length || value.some((id) => !isPositiveId(id))) {
    invalid("order_ids");
  }
  return [...new Set(value.map(Number))].sort((left, right) => left - right);
};

const normalizeInput = (input = {}) => {
  if (!isPositiveId(input.shopId)) invalid("shop_id");
  if (input.actorId != null && !isPositiveId(input.actorId)) invalid("actor_id");
  if (input.terminalPaymentId != null && !isPositiveId(input.terminalPaymentId)) {
    invalid("terminal_payment_id");
  }
  const terminalPaymentId = input.terminalPaymentId == null
    ? null : Number(input.terminalPaymentId);
  const terminalMethodSelected = String(input.paymentMethod || "").trim()
    === TERMINAL_PAYMENT_METHOD;
  if (terminalMethodSelected !== (terminalPaymentId != null)) {
    invalid(terminalMethodSelected ? "terminal_payment_id" : "payment_method");
  }
  const paymentMethod = terminalMethodSelected
    ? TERMINAL_PAYMENT_METHOD : normalizePaymentMethod(input.paymentMethod);
  if (!paymentMethod) invalid("payment_method");
  const discountType = input.discountType == null || input.discountType === ""
    ? "none" : String(input.discountType).trim().toLowerCase();
  if (!["none", "percent", "amount"].includes(discountType)) invalid("discount_type");
  const discountValue = input.discountValue == null || input.discountValue === ""
    ? 0 : parseMoney(input.discountValue);
  if (discountValue == null || discountValue < 0
    || (discountType === "percent" && discountValue > 100)) invalid("discount_value");
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()
    || input.idempotencyKey.trim().length > 191) invalid("idempotency_key");
  return {
    shopId: Number(input.shopId),
    actorId: input.actorId == null ? null : Number(input.actorId),
    orderIds: normalizeOrderIds(input.orderIds),
    paymentMethod,
    discountType: discountValue > 0 ? discountType : "none",
    discountValue: discountValue > 0 ? discountValue : 0,
    idempotencyKey: input.idempotencyKey.trim(),
    terminalPaymentId,
  };
};

const percentOfCents = (amountCents, percent) => {
  const match = String(percent).match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) invalid("discount_value");
  const fraction = match[2] || "";
  const numerator = BigInt(match[1] + fraction);
  const denominator = 100n * (10n ** BigInt(fraction.length));
  return Number((BigInt(amountCents) * numerator + denominator / 2n) / denominator);
};

const calculateDiscountCents = ({ subtotalCents, discountType, discountValue }) => {
  const discountCents = discountType === "percent"
    ? percentOfCents(subtotalCents, discountValue)
    : discountType === "amount" ? toCents(discountValue) : 0;
  if (!Number.isSafeInteger(discountCents) || discountCents < 0
    || discountCents >= subtotalCents) invalid("discount_value");
  return discountCents;
};

const allocateDiscount = (orders, discountCents, subtotalCents) => {
  const allocations = orders.map((order) => {
    const product = BigInt(order.amountCents) * BigInt(discountCents);
    return {
      orderId: order.id,
      discountCents: Number(product / BigInt(subtotalCents)),
      remainder: product % BigInt(subtotalCents),
    };
  });
  let remaining = discountCents - allocations.reduce(
    (sum, allocation) => sum + allocation.discountCents,
    0,
  );
  const ranked = [...allocations].sort((left, right) => {
    if (left.remainder === right.remainder) return left.orderId - right.orderId;
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (let index = 0; index < remaining; index += 1) ranked[index].discountCents += 1;
  return new Map(allocations.map((allocation) => [allocation.orderId, allocation.discountCents]));
};

const orderTableKey = (order) => (order.service_point_id == null
  ? `legacy:${Number(order.customerID)}` : `service-point:${Number(order.service_point_id)}`);

const assertLockedOrders = ({ orders, orderIds, shopId, terminalPaymentId }) => {
  if (orders.length !== orderIds.length || orders.some((order, index) => (
    Number(order.id) !== orderIds[index]
    || Number(order.shopid) !== shopId
    || Number(order.status) !== 3
    || (terminalPaymentId == null
      ? !isCashRegisterOrderDueAndArchivable(order)
      : order.payment_status !== "paid"
        || Number(order.stripe_terminal_payment_id) !== terminalPaymentId)
  ))) fail(409, "TABLE_ORDERS_CHANGED", "Table orders changed.");
  const tableKeys = new Set(orders.map(orderTableKey));
  if (tableKeys.size !== 1) fail(409, "TABLE_ORDERS_CHANGED", "Table orders changed.");
  if (orders.some((order) => order.service_point_id != null
    && order.service_point_type !== "table")) {
    fail(409, "TABLE_ORDERS_CHANGED", "Table orders changed.");
  }
};

const sameIds = (left, right) => left.length === right.length
  && left.every((id, index) => id === right[index]);

const requestFingerprint = (input) => crypto.createHash("sha256").update(JSON.stringify([
  input.orderIds,
  input.actorId,
  input.paymentMethod,
  input.discountType,
  input.discountValue.toFixed(2),
  input.terminalPaymentId,
])).digest("hex");

const receiptOrderDto = (order = {}) => {
  const paymentStatus = order.paymentStatus == null
    ? order.payment_status : order.paymentStatus;
  const refundStatus = order.refundStatus == null
    ? (order.refund_status == null
      ? (paymentStatus === "refunded" ? "succeeded" : null)
      : order.refund_status)
    : order.refundStatus;
  return { ...order, paymentStatus: paymentStatus || null, refundStatus };
};

const receiptDto = (receipt, idempotentReplay) => ({
  id: Number(receipt.id),
  tableReference: receipt.tableReference == null
    ? receipt.table_reference : receipt.tableReference,
  paymentMethod: receipt.paymentMethod == null ? receipt.payment_method : receipt.paymentMethod,
  subtotalBeforeDiscount: Number(receipt.subtotalBeforeDiscount == null
    ? receipt.subtotal_before_discount : receipt.subtotalBeforeDiscount),
  discountType: receipt.discountType == null ? receipt.discount_type : receipt.discountType,
  discountValue: Number(receipt.discountValue == null
    ? receipt.discount_value : receipt.discountValue),
  discountAmount: Number(receipt.discountAmount == null
    ? receipt.discount_amount : receipt.discountAmount),
  totalAmount: Number(receipt.totalAmount == null ? receipt.total_amount : receipt.totalAmount),
  terminalPaymentId: (receipt.terminalPaymentId == null
    ? receipt.stripe_terminal_payment_id : receipt.terminalPaymentId) == null
    ? null : Number(receipt.terminalPaymentId == null
      ? receipt.stripe_terminal_payment_id : receipt.terminalPaymentId),
  createdAt: receipt.createdAt == null ? receipt.created_at : receipt.createdAt,
  archivedOrders: (receipt.archivedOrders || []).map(receiptOrderDto),
  vatBreakdown: receipt.vatBreakdown || [],
  idempotentReplay,
});

const buildCashRegisterSettlementService = ({
  settlementStore,
  archiveOrderInTransaction,
  reconcileOrderBeforeSettlement,
}) => {
  if (!settlementStore || typeof archiveOrderInTransaction !== "function") {
    throw new TypeError("Settlement dependencies are required");
  }

  const getSettlement = async ({ shopId, settlementId }) => {
    if (!isPositiveId(shopId) || !isPositiveId(settlementId)) invalid("settlement_id");
    const receipt = await settlementStore.getSettlementReceipt({
      shopId: Number(shopId),
      settlementId: Number(settlementId),
    });
    if (!receipt) fail(404, "SETTLEMENT_NOT_FOUND", "Settlement not found.");
    return receiptDto(receipt, false);
  };

  const createSettlement = async (rawInput) => {
    const input = normalizeInput(rawInput);
    const fingerprint = requestFingerprint(input);

    const replay = await settlementStore.findByIdempotencyKey({
      shopId: input.shopId,
      idempotencyKey: input.idempotencyKey,
    });
    if (replay) {
      const receipt = await settlementStore.getSettlementReceipt({
        shopId: input.shopId,
        settlementId: replay.id,
      });
      if (!receipt || replay.request_fingerprint !== fingerprint) {
        fail(409, "SETTLEMENT_IDEMPOTENCY_CONFLICT", "Idempotency key already used.");
      }
      return receiptDto(receipt, true);
    }

    if (input.terminalPaymentId == null && typeof reconcileOrderBeforeSettlement === "function") {
      const orders = await settlementStore.listOrdersForSettlement({
        shopId: input.shopId,
        orderIds: input.orderIds,
      });
      if (orders.length === input.orderIds.length) {
        for (const order of orders) {
          if (order.payment_status !== "requires_payment") continue;
          const reconciled = await reconcileOrderBeforeSettlement(order);
          if (!isCashRegisterOrderDueAndArchivable(reconciled)) {
            fail(409, "TABLE_ORDERS_CHANGED", "Table orders changed.");
          }
        }
      }
    }

    return settlementStore.withTransaction(async (store) => {
      await store.lockShop({ shopId: input.shopId });
      const existing = await store.findByIdempotencyKey({
        shopId: input.shopId,
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) {
        const receipt = await store.getSettlementReceipt({
          shopId: input.shopId,
          settlementId: existing.id,
        });
        if (!receipt || existing.request_fingerprint !== fingerprint) {
          fail(409, "SETTLEMENT_IDEMPOTENCY_CONFLICT", "Idempotency key already used.");
        }
        return receiptDto(receipt, true);
      }

      const orders = await store.lockOrders({
        shopId: input.shopId,
        orderIds: input.orderIds,
      });
      const activeTerminalAllocations = await store.lockActiveTerminalAllocations({
        shopId: input.shopId,
        orderIds: input.orderIds,
      });
      if (input.terminalPaymentId == null && activeTerminalAllocations.length) {
        fail(409, "TERMINAL_ORDER_BUSY", "Table orders have an active Terminal payment.");
      }
      assertLockedOrders({ ...input, orders });
      const subtotalCents = orders.reduce((sum, order) => {
        const amountCents = toCents(order.subtotal);
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
          fail(409, "TABLE_ORDERS_CHANGED", "Table orders changed.");
        }
        order.amountCents = amountCents;
        return sum + amountCents;
      }, 0);
      if (!Number.isSafeInteger(subtotalCents)) invalid("orders");

      let discountType = input.discountType;
      let discountValue = input.discountValue;
      let discountCents;
      let discountsByOrder;

      if (input.terminalPaymentId == null) {
        const firstOrder = orders[0];
        const eligible = await store.listEligibleTableOrders({
          shopId: input.shopId,
          servicePointId: firstOrder.service_point_id,
          customerId: firstOrder.customerID,
        });
        if (!sameIds(eligible.map((order) => Number(order.id)).sort((a, b) => a - b), input.orderIds)) {
          fail(409, "TABLE_ORDERS_CHANGED", "Table orders changed.");
        }
        discountCents = calculateDiscountCents({ subtotalCents, discountType, discountValue });
        discountsByOrder = allocateDiscount(orders, discountCents, subtotalCents);
      } else {
        const payment = await store.findTerminalPayment({
          shopId: input.shopId,
          paymentId: input.terminalPaymentId,
        });
        const allocations = await store.listTerminalAllocations({
          shopId: input.shopId,
          paymentId: input.terminalPaymentId,
        });
        const allocationIds = allocations.map((row) => Number(row.order_id)).sort((a, b) => a - b);
        const allocationTotal = allocations.reduce((sum, row) => sum + Number(row.amount_cents), 0);
        const allocationsValid = allocations.every((row) => Number.isSafeInteger(row.amount_cents)
          && row.amount_cents >= 0
          && orders.some((order) => order.id === Number(row.order_id)
            && row.amount_cents <= order.amountCents));
        if (!payment || payment.status !== "succeeded"
          || Number(payment.cashier_user_id) !== input.actorId
          || String(payment.currency || "").toLowerCase() !== "eur"
          || !Number.isSafeInteger(payment.amount_cents) || payment.amount_cents <= 0
          || !sameIds(allocationIds, input.orderIds) || !allocationsValid
          || allocationTotal !== payment.amount_cents) {
          fail(409, "TERMINAL_PAYMENT_NOT_SETTLED", "Terminal payment is not settled.");
        }
        discountCents = subtotalCents - payment.amount_cents;
        const paymentDiscountType = payment.discount_type || "none";
        const persistedDiscountValue = Number(payment.discount_value || 0);
        const expectedDiscountCents = paymentDiscountType === "percent"
          ? percentOfCents(subtotalCents, persistedDiscountValue)
          : paymentDiscountType === "amount" ? persistedDiscountValue : 0;
        const paymentDiscountValue = paymentDiscountType === "amount"
          ? fromCents(persistedDiscountValue) : persistedDiscountValue;
        if (!Number.isSafeInteger(expectedDiscountCents) || discountCents < 0
          || discountCents !== expectedDiscountCents
          || paymentDiscountType !== input.discountType
          || toCents(paymentDiscountValue) !== toCents(input.discountValue)) {
          fail(409, "TERMINAL_PAYMENT_NOT_SETTLED", "Terminal payment is not settled.");
        }
        discountType = paymentDiscountType;
        discountValue = paymentDiscountValue;
        discountsByOrder = new Map(allocations.map((row) => [
          Number(row.order_id),
          orders.find((order) => order.id === Number(row.order_id)).amountCents
            - row.amount_cents,
        ]));
      }

      const firstOrder = orders[0];
      const tableReference = firstOrder.service_point_name || firstOrder.customer
        || String(firstOrder.service_point_id == null ? firstOrder.customerID
          : firstOrder.service_point_id);
      const settlement = await store.insertSettlement({
        shopid: input.shopId,
        service_point_id: firstOrder.service_point_id == null
          ? null : Number(firstOrder.service_point_id),
        table_reference: String(tableReference),
        payment_method: input.paymentMethod,
        subtotal_before_discount: fromCents(subtotalCents),
        discount_type: discountCents > 0 ? discountType : "none",
        discount_value: discountCents > 0 ? discountValue : 0,
        discount_amount: fromCents(discountCents),
        total_amount: fromCents(subtotalCents - discountCents),
        stripe_terminal_payment_id: input.terminalPaymentId,
        idempotency_key: input.idempotencyKey,
        request_fingerprint: fingerprint,
        created_by_user_id: input.actorId,
      });

      for (const order of orders) {
        await archiveOrderInTransaction({
          connection: store.connection,
          orderId: order.id,
          paymentMethod: input.paymentMethod,
          shopId: input.shopId,
          discount: {
            discountType: discountsByOrder.get(order.id) > 0 ? "amount" : "none",
            discountValue: fromCents(discountsByOrder.get(order.id)),
          },
          settlementId: settlement.id,
          lockedOrder: order,
        });
      }
      const receipt = await store.getSettlementReceipt({
        shopId: input.shopId,
        settlementId: settlement.id,
      });
      return receiptDto(receipt, false);
    });
  };

  return { createSettlement, getSettlement };
};

module.exports = {
  allocateDiscount,
  buildCashRegisterSettlementService,
};
