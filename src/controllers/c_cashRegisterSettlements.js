const DomainError = require("../helpers/domainError");
const { custom } = require("../helpers/response");

const settlementFields = [
  "id",
  "tableReference",
  "paymentMethod",
  "subtotalBeforeDiscount",
  "discountType",
  "discountValue",
  "discountAmount",
  "totalAmount",
  "terminalPaymentId",
  "createdAt",
  "idempotentReplay",
];

const archivedOrderFields = [
  "id",
  "token",
  "ordernumber",
  "orderNumber",
  "customer",
  "customer_name",
  "service_point_name",
  "table",
  "username",
  "subtotal",
  "subtotal_before_discount",
  "discount_type",
  "discount_value",
  "discount_amount",
  "payment",
  "used_payment_method",
  "status",
  "created",
  "finished",
  "archived_at",
  "remark",
  "is_takeaway",
  "order_source",
  "source",
  "sale_mode",
  "saleMode",
  "taken_by_name",
  "prepared_by_name",
  "seller_name",
  "cash_register_number",
  "cashRegisterNumber",
  "service_point_cash_register_number",
];

const archivedDetailFields = [
  "name",
  "qty",
  "price",
  "total",
  "remark",
  "vat_rate",
  "vatRate",
  "unit_price_ht",
  "unitPriceHt",
  "unit_vat",
  "unitVat",
  "total_ht",
  "totalHt",
  "total_vat",
  "totalVat",
];

const customizationFields = [
  "step_name",
  "stepName",
  "step_position",
  "stepPosition",
  "name",
  "choice_name",
  "choiceName",
  "choice_position",
  "choicePosition",
  "price",
  "unit_extra_price",
  "extra_price",
];

const vatFields = ["vatRate", "totalHt", "totalVat", "totalTtc"];

const isPositiveInteger = (value) => Number.isSafeInteger(Number(value))
  && Number(value) > 0 && typeof value !== "boolean";

const pickFields = (value, fields) => fields.reduce((result, field) => {
  if (value && Object.prototype.hasOwnProperty.call(value, field)) {
    result[field] = value[field];
  }
  return result;
}, {});

const sanitizeCustomization = (customization) => pickFields(
  customization,
  customizationFields,
);

const sanitizeArchivedDetail = (detail) => ({
  ...pickFields(detail, archivedDetailFields),
  customizationList: Array.isArray(detail && detail.customizationList)
    ? detail.customizationList.map(sanitizeCustomization) : [],
});

const sanitizeArchivedOrder = (order) => ({
  ...pickFields(order, archivedOrderFields),
  details: Array.isArray(order && order.details)
    ? order.details.map(sanitizeArchivedDetail) : [],
});

const sanitizeSettlement = (settlement) => ({
  ...pickFields(settlement, settlementFields),
  archivedOrders: Array.isArray(settlement && settlement.archivedOrders)
    ? settlement.archivedOrders.map(sanitizeArchivedOrder) : [],
  vatBreakdown: Array.isArray(settlement && settlement.vatBreakdown)
    ? settlement.vatBreakdown.map((row) => pickFields(row, vatFields)) : [],
});

const invalidInput = () => new DomainError(
  400,
  "SETTLEMENT_INVALID_INPUT",
  "Invalid settlement request.",
);

let defaultSettlementService;
const getDefaultSettlementService = () => {
  if (!defaultSettlementService) {
    const {
      buildCashRegisterSettlementModule,
    } = require("../modules/m_cashRegisterSettlements");
    const { archiveOrderInTransaction } = require("../modules/m_orders");
    const {
      buildCashRegisterSettlementService,
    } = require("../services/cashRegisterSettlements");
    defaultSettlementService = buildCashRegisterSettlementService({
      settlementStore: buildCashRegisterSettlementModule(),
      archiveOrderInTransaction,
    });
  }
  return defaultSettlementService;
};

const buildCashRegisterSettlementsController = ({
  settlementService,
  logger = console,
} = {}) => {
  const service = () => settlementService || getDefaultSettlementService();

  const sendError = (res, error) => {
    if (error instanceof DomainError) {
      return custom(res, error.status, error.message, null, { code: error.code });
    }
    logger.error("Cash register settlement failed", error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  };

  const createSettlement = async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.orderIds) || !body.orderIds.length
        || body.orderIds.some((id) => !isPositiveInteger(id))) {
        throw invalidInput();
      }
      const discount = body.discount && typeof body.discount === "object"
        && !Array.isArray(body.discount) ? body.discount : {};
      const settlement = await service().createSettlement({
        shopId: req.shopid,
        actorId: req.id,
        orderIds: body.orderIds,
        paymentMethod: body.paymentMethod,
        discountType: discount.discountType == null
          ? body.discountType : discount.discountType,
        discountValue: discount.discountValue == null
          ? body.discountValue : discount.discountValue,
        idempotencyKey: body.idempotencyKey,
        terminalPaymentId: body.terminalPaymentId,
      });
      return custom(
        res,
        settlement.idempotentReplay ? 200 : 201,
        "Encaissement enregistre.",
        null,
        sanitizeSettlement(settlement),
      );
    } catch (error) {
      return sendError(res, error);
    }
  };

  const getSettlement = async (req, res) => {
    try {
      if (!isPositiveInteger(req.params.id)) throw invalidInput();
      const settlement = await service().getSettlement({
        shopId: req.shopid,
        settlementId: Number(req.params.id),
      });
      return custom(
        res,
        200,
        "Encaissement recupere.",
        null,
        sanitizeSettlement(settlement),
      );
    } catch (error) {
      return sendError(res, error);
    }
  };

  return { createSettlement, getSettlement };
};

module.exports = {
  buildCashRegisterSettlementsController,
  ...buildCashRegisterSettlementsController(),
};
