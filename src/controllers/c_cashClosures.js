const {
  mCloseCurrentCashClosure,
  mGetCashClosureById,
  mGetCashClosures,
  mGetCurrentCashClosure,
} = require("../modules/m_cashClosures");
const { custom } = require("../helpers/response");

exports.currentCashClosure = async (req, res) => {
  try {
    const data = await mGetCurrentCashClosure(req.shopid);
    return custom(res, 200, "Apercu Ticket Z.", null, data);
  } catch (error) {
    return custom(res, 500, "Impossible de recuperer l'apercu Ticket Z.", error.message);
  }
};

exports.closeCashClosure = async (req, res) => {
  try {
    const data = await mCloseCurrentCashClosure({
      shopId: req.shopid,
      userId: req.user && req.user.id,
    });
    return custom(res, 201, "Ticket Z cree.", null, data);
  } catch (error) {
    return custom(
      res,
      error.statusCode || 500,
      error.message || "Impossible de cloturer la caisse.",
      error.message
    );
  }
};

exports.allCashClosures = async (req, res) => {
  try {
    const data = await mGetCashClosures(req.shopid);
    return custom(res, 200, "Historique Ticket Z.", null, data);
  } catch (error) {
    return custom(res, 500, "Impossible de recuperer les Tickets Z.", error.message);
  }
};

exports.cashClosureById = async (req, res) => {
  try {
    const data = await mGetCashClosureById({
      shopId: req.shopid,
      id: req.params.id,
    });
    if (!data) return custom(res, 404, "Ticket Z introuvable.", null);
    return custom(res, 200, "Detail Ticket Z.", null, data);
  } catch (error) {
    return custom(res, 500, "Impossible de recuperer le Ticket Z.", error.message);
  }
};
