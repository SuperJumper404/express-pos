const DomainError = require("../helpers/domainError");
const { custom, failed } = require("../helpers/response");
const { isOrderTakerAccess } = require("../helpers/staffAccess");
const { deliveryActor, deliveryEndpoint, deliveryMutation } = require("./c_courier");

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
  dispatch = require("../modules/m_deliveryDispatch").buildDeliveryDispatch(),
  cash = require("../modules/m_courierCash").buildCourierCash(),
  refunds = require("../modules/m_deliveryRefunds").buildDeliveryRefunds(),
  tracking = require("../modules/m_deliveryTracking").buildDeliveryTracking(),
} = {}) => {
  const endpoint = work => async (req, res) => {
    res.set("Cache-Control", "no-store");
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
    trackingRead: endpoint(req => {
      if (Object.keys(req.query || {}).length || Object.keys(req.body || {}).some(key => key !== "token")) throw new DomainError(404, "DELIVERY_NOT_FOUND", "Delivery not found");
      return tracking.read({ token: (req.body || {}).token });
    }),
    trackingRotate: endpoint(req => {
      const body = req.body || {};
      if (Object.keys(body).some(key => !["idempotencyKey", "privateCheckoutContext"].includes(key))) throw new DomainError(404, "DELIVERY_NOT_FOUND", "Delivery not found");
      const session = req.customerSession;
      const actor = session ? { subject: "customer", id: session.customerId, shopId: session.shopId, verifiedSession: true }
        : req.sessionSubject ? deliveryActor(req) : null;
      return tracking.rotate({ actor, privateCheckoutContext: body.privateCheckoutContext, deliveryId: req.params.id, idempotencyKey: body.idempotencyKey });
    }),
    list: deliveryEndpoint(req => dispatch.list({ actor: deliveryActor(req) })),
    detail: deliveryEndpoint(req => dispatch.get({ actor: deliveryActor(req), deliveryId: req.params.id })),
    refund: deliveryEndpoint(req => {
      const body = req.body || {};
      if (Object.keys(body).some(key => !["returnSource", "reason", "idempotencyKey"].includes(key))) {
        throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid manual delivery refund");
      }
      return refunds.refund({ actor: deliveryActor(req), deliveryId: req.params.id, returnSource: body.returnSource,
        reason: body.reason, idempotencyKey: body.idempotencyKey });
    }),
    assign: deliveryEndpoint(req => dispatch.assign(deliveryMutation(req))),
    resolveIssue: deliveryEndpoint(req => dispatch.resolveIssue(deliveryMutation(req))),
    reportIssue: deliveryEndpoint(req => dispatch.reportIssue(deliveryMutation(req))),
    correctTerminal: deliveryEndpoint(req => {
      const body = req.body || {};
      if (Object.keys(body).some(key => !["reason", "expectedVersion", "idempotencyKey"].includes(key))) throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid terminal correction");
      return dispatch.correctTerminal({ actor: deliveryActor(req), deliveryId: req.params.id, reason: body.reason,
        expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey });
    }),
    refundEligibility: deliveryEndpoint(req => dispatch.refundEligibility({ actor: deliveryActor(req), deliveryId: req.params.id })),
    couriers: deliveryEndpoint(req => dispatch.couriers({ actor: deliveryActor(req), financialHolders: req.query.financialHolders === "true" })),
    courierCashBalance: deliveryEndpoint(req => cash.balance({ actor: deliveryActor(req), courierId: req.params.id })),
    remitCourierCash: deliveryEndpoint(req => {
      const body = req.body || {};
      if (Object.keys(body).some(key => !["receivedCents", "expectedBalanceVersion", "idempotencyKey"].includes(key))) {
        throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid courier handover");
      }
      return cash.remit({ actor: deliveryActor(req), courierId: req.params.id, receivedCents: body.receivedCents,
        expectedBalanceVersion: body.expectedBalanceVersion, idempotencyKey: body.idempotencyKey });
    }),
    adjustCourierCash: deliveryEndpoint(req => {
      const body = req.body || {};
      if (Object.keys(body).some(key => !["collectionId", "remittanceId", "deltaDueCents", "reason", "idempotencyKey"].includes(key))) {
        throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid courier correction");
      }
      return cash.adjust({ actor: deliveryActor(req), courierId: req.params.id, collectionId: body.collectionId,
        remittanceId: body.remittanceId, deltaDueCents: body.deltaDueCents, reason: body.reason, idempotencyKey: body.idempotencyKey });
    }),
    courierAvailability: deliveryEndpoint(req => dispatch.availability({ actor: deliveryActor(req), courierId: Number(req.params.id), available: (req.body || {}).available })),
    suggestAddresses: endpoint(req => {
      requireQuoteActor(req);
      const body = req.body || {};
      if (Object.keys(body).some(key => !["input", "sessionToken"].includes(key))) throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid address search");
      return quotes.suggestAddresses({ shopId: req.shopid, input: body.input, sessionToken: body.sessionToken });
    }),
    resolveAddress: endpoint(req => {
      requireQuoteActor(req);
      const body = req.body || {};
      if (Object.keys(body).some(key => !["address", "candidate_id", "selectionToken"].includes(key))
        || (Object.prototype.hasOwnProperty.call(body, "selectionToken") && Object.keys(body).length !== 1)) throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Choose a stored or suggested address");
      return quotes.resolveAddress({ shopId: req.shopid, address: body.address, candidateId: body.candidate_id, selectionToken: body.selectionToken });
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
    availability: endpoint(async req => {
      requireQuoteActor(req);
      const current = await settings.getSettings({ shopId: req.shopid });
      return { enabled: current.enabled === true };
    }),
    updateSettings: endpoint(req => {
      requireAdmin(req);
      const body = req.body || {};
      return settings.updateSettings({ shopId: req.shopid, expectedRevision: body.expectedRevision, settings: body });
    }),
  };
};
module.exports = { buildDeliveryController };
