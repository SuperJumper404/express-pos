const express = require("express");
const stripe = require("../controllers/c_stripe");
const stripeTerminal = require("../controllers/c_stripeTerminal");
const terminalHistory = require("../controllers/c_terminalPaymentHistory");
const orderEditing = require("../controllers/c_orderEditing");
const { attachOptionalCustomerSession, requireCustomerCsrfIfPresent } = require("../helpers/middleware/customerAuth");
const {
  authentication,
  authAdmin,
  authorizeCashRegister,
  authorizeHistory,
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
  .post("/stripe/terminal/payments/:id/cancel", authentication, authorizeCashRegister, stripeTerminal.cancelPayment)
  .get("/stripe/terminal/history", authentication, authorizeHistory, terminalHistory.listEntries)
  .get("/stripe/terminal/standalone-payments/attachment-candidates", authentication, authorizeHistory, terminalHistory.listAttachmentCandidates)
  .get("/stripe/terminal/standalone-payments/:id/attachments", authentication, authorizeHistory, terminalHistory.getAttachments)
  .post("/stripe/terminal/standalone-payments/:id/attachments", authentication, authorizeHistory, terminalHistory.addAttachments)
  .delete("/stripe/terminal/standalone-payments/:id/attachments/:archiveId", authentication, authorizeHistory, terminalHistory.removeAttachment)
  .post("/stripe/terminal/standalone-payments", authentication, authorizeCashRegister, stripeTerminal.startStandalonePayment)
  .get("/stripe/terminal/standalone-payments/:id", authentication, authorizeCashRegister, stripeTerminal.getStandalonePaymentStatus)
  .post("/stripe/terminal/standalone-payments/:id/cancel", authentication, authorizeCashRegister, stripeTerminal.cancelStandalonePayment)
  .get("/stripe/terminal/kiosk/current-reader", authentication, stripeTerminal.getKioskCurrentReader)
  .post("/stripe/terminal/kiosk/payments", authentication, stripeTerminal.startKioskPayment)
  .get("/stripe/terminal/kiosk/payments/:id", authentication, stripeTerminal.getKioskPaymentStatus)
  .post("/stripe/terminal/kiosk/payments/:id/cancel", authentication, stripeTerminal.cancelKioskPayment);

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
    attachOptionalCustomerSession,
    requireCustomerCsrfIfPresent,
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
