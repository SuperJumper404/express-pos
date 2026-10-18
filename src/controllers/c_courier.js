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
const buildCourierController = ({ dispatch = require("../modules/m_deliveryDispatch").buildDeliveryDispatch(),
  collections = require("../modules/m_deliveryCollections").buildDeliveryCollections(),
  cash = require("../modules/m_courierCash").buildCourierCash() } = {}) => ({
  cashBalance: deliveryEndpoint(req => cash.balance({ actor: deliveryActor(req), courierId: req.id })),
  readAvailability: deliveryEndpoint(req => dispatch.readAvailability({ actor: deliveryActor(req) })),
  list: deliveryEndpoint(req => dispatch.list({ actor: deliveryActor(req) })),
  detail: deliveryEndpoint(req => dispatch.get({ actor: deliveryActor(req), deliveryId: req.params.id })),
  pickup: deliveryEndpoint(req => dispatch.pickup(deliveryMutation(req))),
  deliver: deliveryEndpoint(req => dispatch.deliver(deliveryMutation(req))),
  reportIssue: deliveryEndpoint(req => dispatch.reportIssue(deliveryMutation(req))),
  collectPayment: deliveryEndpoint(req => {
    const body = req.body || {};
    if (Object.keys(body).some(key => !["method", "expectedVersion", "idempotencyKey"].includes(key))) {
      throw new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid delivery collection");
    }
    return collections.collect({ actor: deliveryActor(req), deliveryId: req.params.id,
      method: body.method, expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey });
  }),
  availability: deliveryEndpoint(req => dispatch.availability({ actor: deliveryActor(req), available: (req.body || {}).available })),
});
module.exports = { buildCourierController, deliveryActor, deliveryEndpoint, deliveryMutation };
