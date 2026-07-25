const DomainError = require("../helpers/domainError");
const { custom } = require("../helpers/response");
const {
  amendOrder,
  getEditableOrder,
} = require("../modules/m_orderEditing");

const domainResponse = (res, error) => custom(
  res,
  error.status,
  error.message,
  null,
  Object.keys(error).reduce((data, key) => {
    if (!["status", "code", "message", "name"].includes(key)) data[key] = error[key];
    return data;
  }, { code: error.code }),
);

const invalidRequest = (field) => new DomainError(
  400,
  "ORDER_EDIT_REQUEST_INVALID",
  "Requete de modification invalide.",
  { field },
);

const allowedKeys = (value, keys) => (
  value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.has(key))
);

const normalizeAmendBody = (body) => {
  const topLevelKeys = new Set(["content_revision", "expected_total", "items"]);
  if (!allowedKeys(body, topLevelKeys)) throw invalidRequest("body");
  if (!Array.isArray(body.items)) throw invalidRequest("items");
  const itemKeys = new Set([
    "product_id",
    "quantity",
    "selected_product_step_choice_ids",
  ]);
  const items = body.items.map((item, index) => {
    if (!allowedKeys(item, itemKeys)) throw invalidRequest(`items.${index}`);
    const selectedChoiceIds = item.selected_product_step_choice_ids;
    if (selectedChoiceIds != null && !Array.isArray(selectedChoiceIds)) {
      throw invalidRequest(`items.${index}.selected_product_step_choice_ids`);
    }
    return {
      productId: Number(item.product_id),
      quantity: Number(item.quantity),
      selectedChoiceIds: selectedChoiceIds == null
        ? []
        : selectedChoiceIds.map(Number),
    };
  });
  return {
    contentRevision: body.content_revision,
    expectedTotal: body.expected_total,
    items,
  };
};

const buildOrderEditingController = ({
  getEditableOrder: getOrder = getEditableOrder,
  logger = console,
} = {}) => async (req, res) => {
  try {
    const order = await getOrder({
      orderId: req.params.id,
      shopId: req.shopid,
    });
    if (!order) {
      return custom(res, 404, "Commande introuvable.", null, null);
    }
    return custom(res, 200, "Commande editable recuperee.", null, order);
  } catch (error) {
    if (error instanceof DomainError) return domainResponse(res, error);
    logger.error("Editable order read failed", error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

const buildAmendOrderController = ({
  amendOrder: amend = amendOrder,
  logger = console,
} = {}) => async (req, res) => {
  try {
    const normalized = normalizeAmendBody(req.body || {});
    const result = await amend({
      orderId: Number(req.params.id),
      shopId: Number(req.shopid),
      operatorId: Number(req.id),
      ...normalized,
    });
    return custom(res, 200, "Commande modifiee avec succes.", null, result);
  } catch (error) {
    if (error instanceof DomainError) return domainResponse(res, error);
    logger.error("Transactional order amendment failed", error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

module.exports = {
  buildAmendOrderController,
  buildOrderEditingController,
  amendOrder: buildAmendOrderController(),
  getEditableOrder: buildOrderEditingController(),
  normalizeAmendBody,
};
