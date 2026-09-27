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
  "archivedOrders",
  "vatBreakdown",
  "idempotentReplay",
];

const isPositiveInteger = (value) => Number.isSafeInteger(Number(value))
  && Number(value) > 0 && typeof value !== "boolean";

const sanitizeSettlement = (settlement) => settlementFields.reduce((result, field) => {
  if (Object.prototype.hasOwnProperty.call(settlement, field)) result[field] = settlement[field];
  return result;
}, {});

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
