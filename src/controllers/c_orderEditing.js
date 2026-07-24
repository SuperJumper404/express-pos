const DomainError = require("../helpers/domainError");
const { custom, success } = require("../helpers/response");
const { getEditableOrder } = require("../modules/m_orderEditing");

const domainResponse = (res, error) => custom(
  res,
  error.status,
  error.message,
  null,
  Object.keys(error).reduce((data, key) => {
    if (!["status", "message", "name"].includes(key)) data[key] = error[key];
    return data;
  }, { code: error.code }),
);

const buildGetEditableOrderController = ({
  getEditableOrder: loadEditableOrder = getEditableOrder,
} = {}) => async (req, res) => {
  try {
    const data = await loadEditableOrder({
      orderId: Number(req.params.id),
      shopId: Number(req.shopid),
    });
    return success(res, "Commande modifiable récupérée.", null, data);
  } catch (error) {
    if (error instanceof DomainError) return domainResponse(res, error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

module.exports = {
  buildGetEditableOrderController,
  getEditableOrder: buildGetEditableOrderController(),
};
