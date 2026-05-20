const express = require("express");
const stripe = require("../controllers/c_stripe");
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
    "/stripe/refunds/orders/:id",
    authentication,
    authAdmin,
    stripe.refundPaidOrder,
  );

webhookRouter.post("/", stripe.handleWebhook);

module.exports = { routers, webhookRouter };
