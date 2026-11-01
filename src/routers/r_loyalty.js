const express = require('express');
const buildLoyaltyRouter = ({ controller = require('../controllers/c_loyalty').buildLoyaltyController(),
  customerMiddleware = require('../helpers/middleware/customerAuth'),
  authentication = require('../helpers/middleware/auth').authentication } = {}) => {
  const router = express.Router();
  const { requireCustomerSession, requireCustomerCsrf } = customerMiddleware;
  const assets = require('../controllers/c_loyaltyAssets').buildLoyaltyAssetsController();
  const campaigns = require('../controllers/c_loyaltyCampaigns').buildLoyaltyCampaignsController();
  router.get('/loyalty/campaigns', authentication, campaigns.list);
  router.post('/loyalty/campaigns', authentication, campaigns.create);
  router.post('/loyalty/campaigns/:id/send', authentication, campaigns.send);
  router.post('/loyalty/wallet/assets', authentication, assets.publish);
  router.get('/loyalty/wallet/assets/:version/:name', authentication, assets.preview);
  router.get('/customer/loyalty', requireCustomerSession, controller.getPersonal);
  router.post('/customer/loyalty', requireCustomerSession, requireCustomerCsrf, controller.enroll);
  router.patch('/customer/loyalty/preferences', requireCustomerSession, requireCustomerCsrf, controller.setPreferences);
  router.post('/customer/loyalty/wallet/:provider', requireCustomerSession, requireCustomerCsrf, controller.wallet);
  router.get('/loyalty/program', authentication, controller.getProgram);
  router.put('/loyalty/program', authentication, controller.saveProgram);
  router.get('/loyalty/members', authentication, controller.listMembers);
  router.get('/loyalty/members/:memberId', authentication, controller.getStaffMember);
  router.post('/loyalty/lookup', authentication, controller.lookup);
  router.post('/loyalty/kiosk/lookup', authentication, controller.lookupKiosk);
  router.post('/loyalty/kiosk/preview', authentication, controller.previewKiosk);
  router.post('/loyalty/members/:memberId/adjustments', authentication, controller.adjust);
  router.post('/loyalty/orders/:orderId/attach', authentication, controller.attach);
  router.post('/loyalty/orders/:orderId/reserve', authentication, controller.reserve);
  router.post('/loyalty/orders/:orderId/release', authentication, controller.release);
  return router;
};
module.exports = buildLoyaltyRouter();
module.exports.buildLoyaltyRouter = buildLoyaltyRouter;
