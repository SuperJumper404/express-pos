const express = require("express");

const buildCustomersRouter = ({ controller = require("../controllers/c_customers").buildCustomersController(),
  customerAuthController = require("../controllers/c_customers").buildCustomerAuthController(),
  personalController = require("../controllers/c_customers").buildPersonalCustomersController(),
  customerMiddleware = require("../helpers/middleware/customerAuth"),
  authentication = require("../helpers/middleware/auth").authentication } = {}) => {
  const router = express.Router();
  const { requireCustomerSession, requireCustomerCsrf } = customerMiddleware;
  router.get("/customer-auth/channels", customerAuthController.channels);
  router.post("/customer-auth/challenges", customerAuthController.requestChallenge);
  router.post("/customer-auth/verify", customerAuthController.verify);
  router.get("/customer-auth/session", requireCustomerSession, customerAuthController.session);
  router.post("/customer-auth/logout", requireCustomerSession, requireCustomerCsrf, customerAuthController.logout);
  router.post("/customer-auth/link/challenges", requireCustomerSession, requireCustomerCsrf, customerAuthController.requestLinkChallenge);
  router.post("/customer-auth/link/verify", requireCustomerSession, requireCustomerCsrf, customerAuthController.verifyLink);
  router.get("/customer/addresses", requireCustomerSession, personalController.listAddresses);
  router.post("/customer/addresses", requireCustomerSession, requireCustomerCsrf, personalController.saveAddress);
  router.patch("/customer/addresses/:addressId", requireCustomerSession, requireCustomerCsrf, personalController.saveAddress);
  router.delete("/customer/addresses/:addressId", requireCustomerSession, requireCustomerCsrf, personalController.deleteAddress);
  router.post("/customer/address-resolutions", requireCustomerSession, requireCustomerCsrf, personalController.resolveAddress);
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
