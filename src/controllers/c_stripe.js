const { getStripe } = require("../config/stripe");
const {
  envSTRIPEPUBLISHABLEKEY,
  envSTRIPEREFRESHURL,
  envSTRIPERETURNURL,
  envSTRIPEWEBHOOKSECRET,
  envSTRIPEPAYMENTMETHODCONFIGURATIONID,
} = require("../helpers/env");
const DomainError = require("../helpers/domainError");
const { custom, failed, success } = require("../helpers/response");
const {
  isStripePaymentAllowed,
  isStripeRequiredBeforeOrder,
} = require("../helpers/qrPaymentMode");
const {
  buildDestinationPaymentIntentParams,
  toStripeAmount,
} = require("../helpers/stripePayment");
const {
  mGetShopInfo,
  mUpdateStripeAccount,
} = require("../modules/m_shop");
const {
  cancelProvisionalStripeOrder,
  getPaidOrderForRefund,
  getPendingStripeOrderForCounter,
  getStripeOrderForCancellation,
  markPaymentCanceled,
  markPaymentFailed,
  markPaymentRefunded,
  markPaymentSucceeded,
  markStripeOrderPayAtCounter,
  persistPaymentIntentForOrder,
} = require("../modules/m_payments");
const {
  createCheckout,
  normalizeCheckoutRequestBody,
} = require("../modules/m_checkout");

const getBaseUrl = (req) => `${req.protocol}://${req.get("host")}`;

const syncStripeAccountStatus = async (shop, stripeAccount) => {
  const status = {
    stripe_account_id: stripeAccount.id,
    stripe_onboarding_complete:
      stripeAccount.details_submitted &&
      stripeAccount.charges_enabled &&
      stripeAccount.payouts_enabled,
    stripe_charges_enabled: stripeAccount.charges_enabled,
    stripe_payouts_enabled: stripeAccount.payouts_enabled,
  };

  await mUpdateStripeAccount(shop.id, status);
  return status;
};

exports.createConnectOnboardingLink = async (req, res) => {
  try {
    const stripe = getStripe();
    const rows = await mGetShopInfo(req.shopid);
    const shop = rows[0];
    if (!shop) {
      return custom(res, 404, "Restaurant introuvable.", null, null);
    }

    let stripeAccountId = shop.stripe_account_id;
    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "FR",
        email: shop.admin_mail || shop.shop_mail,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: shop.shop_name,
        },
      });
      stripeAccountId = account.id;
      await syncStripeAccountStatus(shop, account);
    } else {
      const account = await stripe.accounts.retrieve(stripeAccountId);
      await syncStripeAccountStatus(shop, account);
    }

    const fallbackUrl = `${getBaseUrl(req)}/settings`;
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: envSTRIPEREFRESHURL || fallbackUrl,
      return_url: envSTRIPERETURNURL || fallbackUrl,
      type: "account_onboarding",
    });

    success(res, "Lien Stripe Connect genere.", null, {
      url: accountLink.url,
      stripe_account_id: stripeAccountId,
    });
  } catch (error) {
    failed(res, "Erreur Stripe Connect.", error.message);
  }
};

exports.getConnectStatus = async (req, res) => {
  try {
    const rows = await mGetShopInfo(req.shopid);
    const shop = rows[0];
    if (!shop) {
      return custom(res, 404, "Restaurant introuvable.", null, null);
    }

    if (!shop.stripe_account_id) {
      return success(res, "Stripe non connecte.", null, {
        connected: false,
        onboarding_complete: false,
        charges_enabled: false,
        payouts_enabled: false,
      });
    }

    const account = await getStripe().accounts.retrieve(shop.stripe_account_id);
    const status = await syncStripeAccountStatus(shop, account);

    success(res, "Statut Stripe Connect recupere.", null, {
      connected: true,
      onboarding_complete: Boolean(status.stripe_onboarding_complete),
      charges_enabled: Boolean(status.stripe_charges_enabled),
      payouts_enabled: Boolean(status.stripe_payouts_enabled),
      stripe_account_id: status.stripe_account_id,
    });
  } catch (error) {
    failed(res, "Erreur lors de la recuperation du statut Stripe.", error.message);
  }
};

const buildQrTablePaymentIntentController = ({
  getShopInfo = mGetShopInfo,
  createCheckout: createStripeCheckout = createCheckout,
  getStripe: getStripeClient = getStripe,
  persistPaymentIntentForOrder: persistPaymentIntent = persistPaymentIntentForOrder,
  cancelProvisionalStripeOrder: cancelProvisional = cancelProvisionalStripeOrder,
  isStripePaymentAllowed: stripePaymentAllowed = isStripePaymentAllowed,
  publishableKey = envSTRIPEPUBLISHABLEKEY,
  paymentMethodConfigurationId = envSTRIPEPAYMENTMETHODCONFIGURATIONID,
  logger = console,
} = {}) => async (req, res) => {
  let provisionalOrderId = null;
  let paymentIntent = null;
  try {
    const body = req.body || {};
    const rows = await getShopInfo(req.shopid);
    const shop = rows[0];
    if (!shop) {
      return custom(res, 404, "Restaurant introuvable.", null, {
        code: "SHOP_NOT_FOUND",
      });
    }

    if ([true, 1, "1", "true"].includes(shop.kitchen_closed)) {
      return custom(res, 422, "La cuisine est fermee.", null, {
        code: "KITCHEN_CLOSED",
      });
    }

    if (!stripePaymentAllowed(shop.qr_payment_mode)) {
      return custom(
        res,
        422,
        "Le paiement Stripe n'est pas actif pour ce restaurant.",
        null,
        { code: "STRIPE_PAYMENT_DISABLED" },
      );
    }

    if (
      !shop.stripe_account_id ||
      ![true, 1, "1", "true"].includes(shop.stripe_charges_enabled)
    ) {
      return custom(
        res,
        422,
        "Le restaurant doit connecter Stripe avant d'accepter les paiements.",
        null,
        { code: "STRIPE_CONNECT_INCOMPLETE" },
      );
    }

    const checkoutResult = await createStripeCheckout({
      shopId: req.shopid,
      actorId: req.id,
      ...normalizeCheckoutRequestBody(body, { paymentModeOverride: "stripe" }),
    });
    provisionalOrderId = checkoutResult.orderId;
    if (checkoutResult.payment_status !== "requires_payment") {
      provisionalOrderId = null;
      return custom(res, 409, "Cette commande a deja ete traitee.", null, {
        orderId: checkoutResult.orderId,
      });
    }

    const stripeParams = buildDestinationPaymentIntentParams({
      amount: checkoutResult.total,
      currency: "eur",
      connectedAccountId: shop.stripe_account_id,
      orderId: provisionalOrderId,
      shopId: req.shopid,
      commissionPercent: shop.stripe_commission_percent,
      paymentMethodConfigurationId,
    });

    paymentIntent = await getStripeClient().paymentIntents.create(stripeParams, {
      idempotencyKey: `qr-${req.shopid}-${body.client_order_token}`,
    });
    const persistence = await persistPaymentIntent({
      orderId: provisionalOrderId,
      shopId: req.shopid,
      stripe_payment_intent_id: paymentIntent.id,
      amount: checkoutResult.total,
      amount_cents: toStripeAmount(checkoutResult.total),
      application_fee_amount: stripeParams.application_fee_amount,
      currency: stripeParams.currency,
      status: paymentIntent.status,
    });
    if (!persistence.attached) {
      if (paymentIntent.status !== "canceled") {
        try {
          await getStripeClient().paymentIntents.cancel(paymentIntent.id);
        } catch (cancelError) {
          logger.error("Stripe terminal PaymentIntent cleanup failed", cancelError);
        }
      }
      provisionalOrderId = null;
      return custom(res, 409, "Cette commande a deja ete traitee.", null, {
        orderId: checkoutResult.orderId,
        payment_status: persistence.payment_status || null,
      });
    }

    success(res, "Paiement Stripe cree.", null, {
      orderId: provisionalOrderId,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      publishableKey,
    });
  } catch (error) {
    if (provisionalOrderId) {
      let externalCancellationConfirmed = !paymentIntent;
      if (paymentIntent && paymentIntent.status !== "canceled") {
        try {
          const canceledPaymentIntent = await getStripeClient().paymentIntents.cancel(
            paymentIntent.id,
          );
          externalCancellationConfirmed = canceledPaymentIntent
            && canceledPaymentIntent.status === "canceled";
        } catch (cancelError) {
          logger.error("Stripe PaymentIntent cleanup failed", cancelError);
        }
      } else if (paymentIntent) {
        externalCancellationConfirmed = true;
      }
      if (externalCancellationConfirmed) {
        try {
          await cancelProvisional(provisionalOrderId, req.shopid);
        } catch (cleanupError) {
          logger.error("Provisional Stripe order cleanup failed", cleanupError);
        }
      }
    }

    if (error instanceof DomainError) {
      const data = { code: error.code };
      for (const key of Object.keys(error)) {
        if (!["status", "code"].includes(key)) data[key] = error[key];
      }
      return custom(res, error.status, error.message, null, data);
    }

    logger.error("Stripe payment creation failed", error);
    return failed(res, "Erreur lors de la creation du paiement Stripe.");
  }
};

exports.buildQrTablePaymentIntentController = buildQrTablePaymentIntentController;
exports.createQrTablePaymentIntent = buildQrTablePaymentIntentController();

const isPositiveOrderId = (value) => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return false;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number > 0;
};
const isReleasedStripeOrder = (order) => order
  && order.payment_provider === "stripe"
  && ["canceled", "failed"].includes(order.payment_status);
const canceledStripeResponse = (res, orderId, idempotentReplay) => custom(
  res,
  200,
  idempotentReplay ? "Paiement Stripe deja annule." : "Paiement Stripe annule.",
  null,
  {
    orderId,
    canceled: true,
    idempotent_replay: idempotentReplay,
  },
);

const buildCancelQrTablePaymentIntentController = ({
  getStripeOrderForCancellation: findOrder = getStripeOrderForCancellation,
  getStripe: getStripeClient = getStripe,
  cancelProvisionalStripeOrder: cancelProvisional = cancelProvisionalStripeOrder,
  logger = console,
} = {}) => async (req, res) => {
  const rawOrderId = req.params && req.params.orderId;
  if (!isPositiveOrderId(rawOrderId)) {
    return custom(res, 400, "Identifiant de commande invalide.", null, {
      code: "STRIPE_ORDER_CANCEL_INVALID",
      field: "order_id",
    });
  }

  const orderId = Number(rawOrderId);
  let order;
  try {
    order = await findOrder(orderId, req.shopid);
  } catch (error) {
    logger.error("Stripe cancellation order lookup failed", error);
    return custom(res, 500, "Erreur lors de l'annulation du paiement Stripe.", null, {
      code: "INTERNAL_ERROR",
    });
  }

  if (!order) {
    return custom(res, 404, "Commande Stripe introuvable.", null, {
      code: "STRIPE_ORDER_NOT_FOUND",
    });
  }

  if (isReleasedStripeOrder(order)) {
    return canceledStripeResponse(res, orderId, true);
  }

  if (order.payment_provider !== "stripe" || order.payment_status !== "requires_payment") {
    return custom(res, 409, "Cette commande ne peut plus etre annulee.", null, {
      code: "STRIPE_ORDER_NOT_CANCELABLE",
      payment_status: order.payment_status || null,
    });
  }

  if (!order.stripe_payment_intent_id) {
    return custom(res, 409, "Le paiement Stripe ne peut pas etre annule.", null, {
      code: "STRIPE_PAYMENT_CANCEL_FAILED",
    });
  }

  let paymentIntent;
  let externalCancellationReplay = false;
  try {
    paymentIntent = await getStripeClient().paymentIntents.retrieve(
      order.stripe_payment_intent_id,
    );
    if (paymentIntent.status === "succeeded") {
      return custom(res, 409, "Le paiement est deja confirme par Stripe.", null, {
        code: "STRIPE_PAYMENT_ALREADY_SUCCEEDED",
      });
    }
  } catch (error) {
    logger.error("Stripe PaymentIntent retrieval failed", error);
    return custom(res, 409, "Le paiement Stripe ne peut pas etre annule.", null, {
      code: "STRIPE_PAYMENT_CANCEL_FAILED",
    });
  }

  if (paymentIntent.status === "canceled") {
    externalCancellationReplay = true;
  } else {
    try {
      paymentIntent = await getStripeClient().paymentIntents.cancel(
        order.stripe_payment_intent_id,
      );
    } catch (cancelError) {
      logger.error("Stripe PaymentIntent cancellation failed", cancelError);
      try {
        paymentIntent = await getStripeClient().paymentIntents.retrieve(
          order.stripe_payment_intent_id,
        );
      } catch (refreshError) {
        logger.error("Stripe PaymentIntent cancellation refresh failed", refreshError);
        return custom(res, 409, "Le paiement Stripe ne peut pas etre annule.", null, {
          code: "STRIPE_PAYMENT_CANCEL_FAILED",
        });
      }

      if (paymentIntent.status === "succeeded") {
        return custom(res, 409, "Le paiement est deja confirme par Stripe.", null, {
          code: "STRIPE_PAYMENT_ALREADY_SUCCEEDED",
        });
      }
      if (paymentIntent.status !== "canceled") {
        return custom(res, 409, "Le paiement Stripe ne peut pas etre annule.", null, {
          code: "STRIPE_PAYMENT_CANCEL_FAILED",
        });
      }
      externalCancellationReplay = true;
    }
  }

  if (!paymentIntent || paymentIntent.status !== "canceled") {
    return custom(res, 409, "Le paiement Stripe ne peut pas etre annule.", null, {
      code: "STRIPE_PAYMENT_CANCEL_FAILED",
    });
  }

  try {
    const cancellation = await cancelProvisional(orderId, req.shopid);
    if (cancellation && cancellation.missing) {
      return custom(res, 404, "Commande Stripe introuvable.", null, {
        code: "STRIPE_ORDER_NOT_FOUND",
      });
    }
    if (cancellation && cancellation.ignored) {
      const currentOrder = await findOrder(orderId, req.shopid);
      if (isReleasedStripeOrder(currentOrder)) {
        return canceledStripeResponse(res, orderId, true);
      }
    }
    if (!cancellation || !cancellation.canceled) {
      return custom(res, 409, "Cette commande ne peut plus etre annulee.", null, {
        code: "STRIPE_ORDER_NOT_CANCELABLE",
      });
    }
    return canceledStripeResponse(res, orderId, externalCancellationReplay);
  } catch (error) {
    logger.error("Provisional Stripe order cancellation failed", error);
    return custom(res, 500, "Erreur lors de l'annulation du paiement Stripe.", null, {
      code: "INTERNAL_ERROR",
    });
  }
};

exports.buildCancelQrTablePaymentIntentController = buildCancelQrTablePaymentIntentController;
exports.cancelQrTablePaymentIntent = buildCancelQrTablePaymentIntentController();

exports.markQrTablePaymentAtCounter = async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const rows = await mGetShopInfo(req.shopid);
    const shop = rows[0];

    if (!shop) {
      return custom(res, 404, "Restaurant introuvable.", null, null);
    }

    if (isStripeRequiredBeforeOrder(shop.qr_payment_mode)) {
      return custom(
        res,
        422,
        "Le paiement en ligne est obligatoire pour ce restaurant.",
        null,
        null,
      );
    }

    const pendingOrders = await getPendingStripeOrderForCounter(
      orderId,
      req.shopid,
    );
    if (!pendingOrders.length) {
      return custom(res, 404, "Commande Stripe en attente introuvable.", null, null);
    }

    const stripe = getStripe();
    const paymentIntentId = pendingOrders[0].stripe_payment_intent_id;
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === "succeeded") {
      return custom(
        res,
        409,
        "Le paiement est deja confirme par Stripe.",
        null,
        null,
      );
    }

    if (paymentIntent.status !== "canceled") {
      await stripe.paymentIntents.cancel(paymentIntentId);
    }

    await markStripeOrderPayAtCounter(orderId, req.shopid);

    success(res, "Commande envoyee. Paiement au comptoir a la fin.", null, {
      orderId,
    });
  } catch (error) {
    failed(
      res,
      "Erreur lors de l'envoi de la commande sans paiement.",
      error.message,
    );
  }
};

exports.handleWebhook = async (req, res) => {
  try {
    const stripe = getStripe();
    const signature = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      envSTRIPEWEBHOOKSECRET,
    );

    if (event.type === "payment_intent.succeeded") {
      const paymentIntent = event.data.object;
      const charge = paymentIntent.latest_charge
        ? await stripe.charges.retrieve(paymentIntent.latest_charge)
        : null;
      await markPaymentSucceeded(paymentIntent, charge);
    }

    if (
      event.type === "payment_intent.payment_failed"
    ) {
      await markPaymentFailed(event.data.object.id);
    }

    if (event.type === "payment_intent.canceled") {
      await markPaymentCanceled(event.data.object.id);
    }

    res.json({ received: true });
  } catch (error) {
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
};

exports.refundPaidOrder = async (req, res) => {
  try {
    const orderId = req.params.id;
    const rows = await getPaidOrderForRefund(orderId, req.shopid);

    if (!rows.length) {
      return custom(res, 404, "Commande payee introuvable.", null, null);
    }

    const refund = await getStripe().refunds.create({
      payment_intent: rows[0].stripe_payment_intent_id,
      reverse_transfer: true,
      refund_application_fee: true,
    });

    await markPaymentRefunded(orderId, refund.id);
    success(res, "Commande remboursee.", null, { refundId: refund.id });
  } catch (error) {
    failed(res, "Erreur lors du remboursement Stripe.", error.message);
  }
};
