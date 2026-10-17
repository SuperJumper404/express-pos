const express = require("express");

const buildCustomersRouter = ({ controller = require("../controllers/c_customers").buildCustomersController(),
  customerAuthController = require("../controllers/c_customers").buildCustomerAuthController(),
  authentication = require("../helpers/middleware/auth").authentication } = {}) => {
  const router = express.Router();
  router.get("/customer-auth/channels", customerAuthController.channels);
  router.post("/customer-auth/challenges", customerAuthController.requestChallenge);
  router.get("/delivery/customers", authentication, controller.searchProfiles);
  router.post("/delivery/customers", authentication, controller.createProfile);
  router.get("/delivery/customers/:customerId/addresses", authentication, controller.listAddresses);
  router.post("/delivery/customers/:customerId/addresses", authentication, controller.saveAddress);
  router.patch("/delivery/customers/:customerId/addresses/:addressId", authentication, controller.saveAddress);
  router.delete("/delivery/customers/:customerId/addresses/:addressId", authentication, controller.deleteAddress);
  router.post("/delivery/customers/:customerId/addresses/:addressId/resolve", authentication, controller.resolveStoredAddress);
  return router;
};

module.exports = buildCustomersRouter();
module.exports.buildCustomersRouter = buildCustomersRouter;
