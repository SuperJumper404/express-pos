const express = require("express");
const buildDeliveryRouter = ({
  controller = require("../controllers/c_delivery").buildDeliveryController(),
  authentication = require("../helpers/middleware/auth").authentication,
} = {}) => {
  const router = express.Router();
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
