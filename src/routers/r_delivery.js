const express = require("express");
const buildDeliveryRouter = ({
  controller = require("../controllers/c_delivery").buildDeliveryController(),
  authentication = require("../helpers/middleware/auth").authentication,
  readLimit = 30,
  readClock = () => Date.now(),
  customerMiddleware = require("../helpers/middleware/customerAuth"),
} = {}) => {
  const router = express.Router();
  const reads = new Map();
  const privateHeaders = (req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); next(); };
  const limitReads = (req, res, next) => {
    const now = readClock();
    for (const [ip, entry] of reads) if (entry.until <= now) reads.delete(ip);
    const ip = req.ip;
    const entry = reads.get(ip) || { count: 0, until: now + 60000 };
    if (entry.count >= readLimit || (!reads.has(ip) && reads.size >= 10000)) {
      res.set("Retry-After", "60");
      return require("../helpers/response").failed(res, "Tracking temporarily unavailable", "DELIVERY_READ_LIMIT", 429);
    }
    entry.count++; reads.set(ip, entry); next();
  };
  const rotationContext = (req, res, next) => {
    if (req.headers.authorization) return authentication(req, res, next);
    if ((req.body || {}).privateCheckoutContext) return next();
    const customer = require("../helpers/middleware/customerAuth");
    if (!customer.rawCustomerToken(req)) return next();
    return customerMiddleware.requireCustomerSession(req, res, () => customerMiddleware.requireCustomerCsrf(req, res, next));
  };
  router.post("/delivery/tracking/read", privateHeaders, limitReads, controller.trackingRead);
  router.post("/deliveries/:id/tracking-token", privateHeaders, rotationContext, controller.trackingRotate);
  router.post("/delivery/address-resolutions", authentication, controller.resolveAddress);
  router.post("/delivery/quotes", authentication, controller.createQuote);
  router.get("/delivery/settings", authentication, controller.getSettings);
  router.get("/delivery/availability", authentication, controller.availability);
  router.put("/delivery/settings", authentication, controller.updateSettings);
  const operator = require("../helpers/middleware/auth").buildModuleAuthorization({ moduleKey: "delivery" });
  const restaurant = (req, res, next) => {
    if (req.sessionSubject !== "staff" || ![0, 1].includes(Number(req.access))) return require("../helpers/response").custom(res, 403, "Access denied", {}, null);
    return operator(req, res, next);
  };
  router.get("/deliveries", authentication, restaurant, controller.list);
  router.get("/deliveries/:id", authentication, restaurant, controller.detail);
  router.post("/deliveries/:id/refund", authentication, restaurant, controller.refund);
  router.get("/deliveries/:id/refund-eligibility", authentication, restaurant, controller.refundEligibility);
  router.post("/deliveries/:id/correct-terminal", authentication, restaurant, controller.correctTerminal);
  router.post("/deliveries/:id/assign", authentication, restaurant, controller.assign);
  router.post("/deliveries/:id/resolve-issue", authentication, restaurant, controller.resolveIssue);
  router.post("/deliveries/:id/report-issue", authentication, restaurant, controller.reportIssue);
  router.get("/delivery/couriers", authentication, restaurant, controller.couriers);
  router.get("/delivery/couriers/:id/cash-balance", authentication, restaurant, controller.courierCashBalance);
  router.post("/delivery/couriers/:id/remittances", authentication, restaurant, controller.remitCourierCash);
  router.post("/delivery/couriers/:id/adjustments", authentication, restaurant, controller.adjustCourierCash);
  router.patch("/delivery/couriers/:id/availability", authentication, restaurant, controller.courierAvailability);
  return router;
};
module.exports = buildDeliveryRouter();
module.exports.buildDeliveryRouter = buildDeliveryRouter;
