const express = require("express");
const buildDeliveryRouter = ({
  controller = require("../controllers/c_delivery").buildDeliveryController(),
  authentication = require("../helpers/middleware/auth").authentication,
} = {}) => {
  const router = express.Router();
  router.post("/delivery/address-resolutions", authentication, controller.resolveAddress);
  router.post("/delivery/quotes", authentication, controller.createQuote);
  router.get("/delivery/settings", authentication, controller.getSettings);
  router.put("/delivery/settings", authentication, controller.updateSettings);
  return router;
};
module.exports = buildDeliveryRouter();
module.exports.buildDeliveryRouter = buildDeliveryRouter;
