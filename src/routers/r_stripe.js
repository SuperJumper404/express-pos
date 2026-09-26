const express = require("express");
const stripe = require("../controllers/c_stripe");
const stripeTerminal = require("../controllers/c_stripeTerminal");
const orderEditing = require("../controllers/c_orderEditing");
const {
  authentication,
  authAdmin,
  authorizeCashRegister,
} = require("../helpers/middleware/auth");

const routers = express.Router();
const webhookRouter = express.Router();

routers
  .get("/stripe/terminal/readers", authentication, authAdmin, stripeTerminal.listReaders)
  .post("/stripe/terminal/readers", authentication, authAdmin, stripeTerminal.registerReader)
  .patch("/stripe/terminal/readers/:id/assignment", authentication, authAdmin, stripeTerminal.assignReader)
  .patch("/stripe/terminal/readers/:id/status", authentication, authAdmin, stripeTerminal.setReaderActive)
  .post("/stripe/terminal/readers/refresh", authentication, authAdmin, stripeTerminal.refreshReaders)
  .get("/stripe/terminal/current-reader", authentication, authorizeCashRegister, stripeTerminal.getCurrentReader)
  .post("/stripe/terminal/payments", authentication, authorizeCashRegister, stripeTerminal.startPayment)
  .get("/stripe/terminal/payments/:id", authentication, authorizeCashRegister, stripeTerminal.getPaymentStatus)
  .post("/stripe/terminal/payments/:id/cancel", authentication, authorizeCashRegister, stripeTerminal.cancelPayment);

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
    "/stripe/orders/:id/replacement-payment",
    authentication,
    orderEditing.replacementPayment,
  )
  .post(
    "/stripe/refunds/orders/:id",
    authentication,
    authAdmin,
    stripe.refundPaidOrder,
  );

webhookRouter.post("/", stripe.handleWebhook);

module.exports = { routers, webhookRouter };
