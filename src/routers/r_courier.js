const express = require("express");
const { custom } = require("../helpers/response");
const buildCourierRouter = ({
  controller = require("../controllers/c_courier").buildCourierController(),
  authentication = require("../helpers/middleware/auth").authentication,
} = {}) => {
  const router = express.Router();
  router.use("/courier", authentication, (req, res, next) => {
    if (req.sessionSubject !== "staff" || Number(req.access) !== 6) return custom(res, 403, "Access denied", {}, null);
    return next();
  });
  router.get("/courier/deliveries", controller.list);
  router.get("/courier/cash-balance", controller.cashBalance);
  router.get("/courier/deliveries/:id", controller.detail);
  router.patch("/courier/availability", controller.availability);
  router.post("/courier/deliveries/:id/pickup", controller.pickup);
  router.post("/courier/deliveries/:id/deliver", controller.deliver);
  router.post("/courier/deliveries/:id/report-issue", controller.reportIssue);
  router.post("/courier/deliveries/:id/collect-payment", controller.collectPayment);
  return router;
};
module.exports = buildCourierRouter();
module.exports.buildCourierRouter = buildCourierRouter;
