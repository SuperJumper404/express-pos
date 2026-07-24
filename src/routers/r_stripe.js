const express = require("express");
const stripe = require("../controllers/c_stripe");
const orderEditing = require("../controllers/c_orderEditing");
const {
  authentication,
  authAdmin,
} = require("../helpers/middleware/auth");

const routers = express.Router();
const webhookRouter = express.Router();

routers
  .get("/stripe/connect/status", authentication, authAdmin, stripe.getConnectStatus)
  .post(
    "/stripe/connect/onboarding-link",
    authentication,
    authAdmin,
    stripe.createConnectOnboardingLink,
  )
  .post(
    "/stripe/payment-intents/qr-table",
    authentication,
    stripe.createQrTablePaymentIntent,
  )
  .post(
    "/stripe/payment-intents/qr-table/:orderId/cancel",
    authentication,
    stripe.cancelQrTablePaymentIntent,
  )
  .post(
    "/stripe/payment-intents/qr-table/:orderId/pay-at-counter",
    authentication,
    stripe.markQrTablePaymentAtCounter,
  )
  .post(
    "/stripe/payment-intents/orders/:id/regenerate",
    authentication,
    orderEditing.regenerateOrderPaymentIntent,
  )
  .post(
    "/stripe/refunds/orders/:id",
    authentication,
    authAdmin,
    stripe.refundPaidOrder,
  );

webhookRouter.post("/", stripe.handleWebhook);

module.exports = { routers, webhookRouter };
