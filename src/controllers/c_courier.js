const DomainError = require("../helpers/domainError");
const { custom, failed } = require("../helpers/response");

const deliveryActor = req => ({ subject: req.sessionSubject, id: req.id, shopId: req.shopid, access: req.access });
const deliveryEndpoint = work => async (req, res) => {
  res.set("Cache-Control", "no-store");
  try { return custom(res, 200, "OK", null, await work(req)); }
  catch (error) {
    if (error instanceof DomainError) {
      if (error.delivery) return res.status(error.status).json({ code: error.status, success: false, message: error.message, pagination: null, data: { delivery: error.delivery }, error: error.code });
      return failed(res, error.message, error.code, error.status);
    }
    return failed(res, "Delivery service unavailable", "DELIVERY_UNAVAILABLE", 503);
  }
};
const deliveryMutation = req => {
  const body = req.body || {};
  return { actor: deliveryActor(req), deliveryId: req.params.id,
    expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey,
    reason: body.reason, action: body.action, courierId: body.courierId,
    physicalTransferConfirmed: body.physicalTransferConfirmed };
};
const buildCourierController = ({ dispatch = require("../modules/m_deliveryDispatch").buildDeliveryDispatch() } = {}) => ({
  list: deliveryEndpoint(req => dispatch.list({ actor: deliveryActor(req) })),
  detail: deliveryEndpoint(req => dispatch.get({ actor: deliveryActor(req), deliveryId: req.params.id })),
  pickup: deliveryEndpoint(req => dispatch.pickup(deliveryMutation(req))),
  deliver: deliveryEndpoint(req => dispatch.deliver(deliveryMutation(req))),
  reportIssue: deliveryEndpoint(req => dispatch.reportIssue(deliveryMutation(req))),
  availability: deliveryEndpoint(req => dispatch.availability({ actor: deliveryActor(req), available: (req.body || {}).available })),
});
module.exports = { buildCourierController, deliveryActor, deliveryEndpoint, deliveryMutation };
