const DomainError = require("../helpers/domainError");
const { custom } = require("../helpers/response");
const { getEditableOrder } = require("../modules/m_orderEditing");

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
    if (error instanceof DomainError) {
      return custom(res, error.status, error.message, null, { code: error.code });
    }
    logger.error("Editable order read failed", error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

module.exports = {
  buildOrderEditingController,
  getEditableOrder: buildOrderEditingController(),
};
