const DomainError = require("../helpers/domainError");
const { custom, failed } = require("../helpers/response");
const { isOrderTakerAccess } = require("../helpers/staffAccess");

const forbidden = () => new DomainError(403, "DELIVERY_FORBIDDEN", "Access denied");
const requireQuoteActor = req => {
  if (!req.shopid || (req.sessionSubject === "service_point" ? !req.servicePointId : !req.id || !isOrderTakerAccess(req.access))) throw forbidden();
};
const requireAdmin = req => {
  if (req.sessionSubject === "service_point" || !req.id || req.access !== 0 || !req.shopid) throw forbidden();
};
const buildDeliveryController = ({
  quotes = require("../modules/m_deliveryQuotes").buildDeliveryQuotes(),
  settings = require("../modules/m_deliverySettings").buildDeliverySettings(),
} = {}) => {
  const endpoint = work => async (req, res) => {
    try { return custom(res, 200, "OK", null, await work(req)); }
    catch (error) {
      if (error instanceof DomainError) {
        if (error.candidates && error.candidates.length) return res.status(error.status).json({ code: error.status, success: false, message: error.message, pagination: null, data: { candidates: error.candidates }, error: error.code });
        return failed(res, error.message, error.code, error.status);
      }
      return failed(res, "Delivery service unavailable", "DELIVERY_UNAVAILABLE", 503);
    }
  };
  return {
    resolveAddress: endpoint(req => {
      requireQuoteActor(req);
      const body = req.body || {};
      return quotes.resolveAddress({ shopId: req.shopid, address: body.address, candidateId: body.candidate_id });
    }),
    createQuote: endpoint(req => {
      requireQuoteActor(req);
      const body = req.body || {};
      let discount = body.discount;
      if (body.discount_type !== undefined || body.discount_value !== undefined) {
        if (discount !== undefined) throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Ambiguous discount intent");
        discount = { type: body.discount_type || "none", value: body.discount_value === undefined ? 0 : body.discount_value };
      }
      if (req.sessionSubject === "service_point" && discount !== undefined && (discount === null || discount.type !== "none" || discount.value !== 0)) throw forbidden();
      if (!Array.isArray(body.items)) throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Items are required");
      const items = body.items.map(item => ({
        productId: item && item.product_id, quantity: item && item.quantity,
        selectedChoiceIds: item && item.selected_product_step_choice_ids === undefined ? [] : item && item.selected_product_step_choice_ids,
      }));
      return quotes.createQuote({ shopId: req.shopid, items, discount, addressResolutionToken: body.address_resolution_token });
    }),
    getSettings: endpoint(req => { requireAdmin(req); return settings.getSettings({ shopId: req.shopid }); }),
    updateSettings: endpoint(req => {
      requireAdmin(req);
      const body = req.body || {};
      return settings.updateSettings({ shopId: req.shopid, expectedRevision: body.expectedRevision, settings: body });
    }),
  };
};
module.exports = { buildDeliveryController };
