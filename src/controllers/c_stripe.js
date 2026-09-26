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
  markPaymentAttemptFailed,
  markPaymentCanceled,
  markPaymentProcessing,
  markPaymentSucceeded,
  markStripeOrderPayAtCounter,
  persistPaymentIntentForOrder,
  persistReplacementPaymentIntent,
  recordRefundState,
  reconcileStripeRefund,
} = require("../modules/m_payments");
const {
  createCheckout,
  normalizeCheckoutRequestBody,
} = require("../modules/m_checkout");

const getBaseUrl = (req) => `${req.protocol}://${req.get("host")}`;
const { mFindOrderById } = require("../modules/m_orders");
const { buildStripeTerminalModule } = require("../modules/m_stripeTerminal");
const { buildStripeTerminalWebhookHandler, retryTerminalTransaction } = require("../services/stripeTerminalWebhooks");

const getTerminalStore = () => {
  const connection = require("../config/dbPool");
  const { withTransaction } = require("../helpers/withTransaction");
  return {
    ...buildStripeTerminalModule({ connection }),
    withTransaction: (work) => withTransaction((transaction) => work(
      buildStripeTerminalModule({ connection: transaction }),
    )),
  };
};
const handleTerminalWebhookEvent = (event) => buildStripeTerminalWebhookHandler({ terminalStore: getTerminalStore() })(event);

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

    const checkoutInput = {
      shopId: req.shopid,
      actorId: req.id,
      ...normalizeCheckoutRequestBody(body, { paymentModeOverride: "stripe" }),
    };
    if (req.sessionSubject === "service_point") {
      checkoutInput.sessionSubject = "service_point";
      checkoutInput.servicePointId = req.servicePointId;
      checkoutInput.orderSource = req.orderSource;
    }
    const checkoutResult = await createStripeCheckout(checkoutInput);
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
          await cancelProvisional(
            provisionalOrderId,
            req.shopid,
            paymentIntent ? paymentIntent.id : null,
          );
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

const buildRegenerateOrderPaymentIntent = ({
  getShopInfo = mGetShopInfo,
  getStripe: getStripeClient = getStripe,
  persistReplacementPaymentIntent: persistReplacement = persistReplacementPaymentIntent,
  publishableKey = envSTRIPEPUBLISHABLEKEY,
  paymentMethodConfigurationId = envSTRIPEPAYMENTMETHODCONFIGURATIONID,
} = {}) => async ({ order, contentRevision }) => {
  const stripe = getStripeClient();
  const paymentResponse = (paymentIntent) => ({
    orderId: Number(order.id),
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    publishableKey,
  });
  const usable = (paymentIntent) => paymentIntent
    && !["canceled", "succeeded"].includes(paymentIntent.status)
    && paymentIntent.client_secret;

  if (order.stripe_payment_intent_id) {
    let attached;
    try {
      attached = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
    } catch (error) {
      throw new DomainError(
        409,
        "STRIPE_PAYMENT_INTENT_UNAVAILABLE",
        "Le paiement Stripe attache ne peut pas etre recupere.",
      );
    }
    if (!usable(attached)) {
      throw new DomainError(
        409,
        "STRIPE_PAYMENT_INTENT_TERMINAL",
        "Le paiement Stripe attache n'est plus utilisable.",
      );
    }
    return paymentResponse(attached);
  }

  if (!order.stripe_replacement_attempt_token) {
    throw new DomainError(
      409,
      "STRIPE_REPLACEMENT_ATTEMPT_MISSING",
      "La tentative de remplacement Stripe est introuvable.",
    );
  }
  const rows = await getShopInfo(order.shopid);
  const shop = rows[0];
  if (!shop
    || !shop.stripe_account_id
    || ![true, 1, "1", "true"].includes(shop.stripe_charges_enabled)) {
    throw new DomainError(
      422,
      "STRIPE_CONNECT_INCOMPLETE",
      "Le restaurant doit connecter Stripe avant d'accepter les paiements.",
    );
  }
  const params = buildDestinationPaymentIntentParams({
    amount: order.subtotal,
    currency: "eur",
    connectedAccountId: shop.stripe_account_id,
    orderId: order.id,
    shopId: order.shopid,
    commissionPercent: shop.stripe_commission_percent,
    paymentMethodConfigurationId,
  });
  const paymentIntent = await stripe.paymentIntents.create(params, {
    idempotencyKey: `order-edit:${order.shopid}:${order.id}:${contentRevision}`,
  });
  if (!usable(paymentIntent)) {
    throw new DomainError(
      409,
      "STRIPE_PAYMENT_INTENT_TERMINAL",
      "Le nouveau paiement Stripe n'est pas utilisable.",
    );
  }

  let persistence;
  try {
    persistence = await persistReplacement({
      orderId: order.id,
      shopId: order.shopid,
      stripe_payment_intent_id: paymentIntent.id,
      amount: order.subtotal,
      amount_cents: toStripeAmount(order.subtotal),
      application_fee_amount: params.application_fee_amount,
      currency: params.currency,
      status: paymentIntent.status,
      replacement_attempt_token: order.stripe_replacement_attempt_token,
    });
  } catch (error) {
    // Keep the idempotent Stripe intent available for a later attachment retry.
    throw error;
  }
  if (!persistence.attached) {
    try {
      await stripe.paymentIntents.cancel(paymentIntent.id);
    } catch (error) {
      // A stale intent is never attached locally; webhook handling remains harmless.
    }
    throw new DomainError(409, "ORDER_EDIT_CONFLICT", "La commande a change.");
  }
  return paymentResponse(paymentIntent);
};

exports.buildRegenerateOrderPaymentIntent = buildRegenerateOrderPaymentIntent;
exports.regenerateOrderPaymentIntent = buildRegenerateOrderPaymentIntent();

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
    const cancellation = await cancelProvisional(
      orderId,
      req.shopid,
      order.stripe_payment_intent_id,
    );
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

const buildMarkQrTablePaymentAtCounter = ({
  getShopInfo = mGetShopInfo,
  getPendingStripeOrderForCounter: findPendingOrder = getPendingStripeOrderForCounter,
  getStripe: getStripeClient = getStripe,
  markStripeOrderPayAtCounter: markPayAtCounter = markStripeOrderPayAtCounter,
} = {}) => async (req, res) => {
  try {
    const orderId = req.params.orderId;
    const rows = await getShopInfo(req.shopid);
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

    const pendingOrders = await findPendingOrder(
      orderId,
      req.shopid,
    );
    if (!pendingOrders.length) {
      return custom(res, 404, "Commande Stripe en attente introuvable.", null, null);
    }

    const stripe = getStripeClient();
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

    const transition = await markPayAtCounter(orderId, req.shopid, paymentIntentId);
    if (!transition || transition.ignored) {
      return custom(
        res,
        409,
        "Le paiement Stripe ne peut pas etre modifie pour cette commande.",
        null,
        { code: "STRIPE_PAYMENT_NOT_SETTLED" },
      );
    }

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

const stripeObjectId = (value) => (
  typeof value === "string" ? value : value && value.id
);

const listStripeRefundsByCharge = async (
  stripe,
  chargeId,
  expectedRefundId,
) => {
  if (!stripe.refunds || typeof stripe.refunds.list !== "function") {
    throw new Error("Stripe refund listing is unavailable");
  }
  let startingAfter = null;
  let total = 0;
  const refunds = [];
  const seenCursors = new Set();
  const seenRefundIds = new Set();
  const refundStatuses = new Set([
    "pending",
    "requires_action",
    "succeeded",
    "failed",
    "canceled",
  ]);
  for (;;) {
    const params = { charge: chargeId, limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const page = await stripe.refunds.list(params);
    if (!page || !Array.isArray(page.data) || typeof page.has_more !== "boolean") {
      throw new Error("Stripe refund pagination is malformed");
    }
    for (const candidate of page.data) {
      const refundId = stripeObjectId(candidate);
      if (!refundId
        || seenRefundIds.has(refundId)
        || !refundStatuses.has(candidate.status)) {
        throw new Error("Stripe refund page contains invalid data");
      }
      seenRefundIds.add(refundId);
      refunds.push(candidate);
      if (candidate.status !== "succeeded") continue;
      const amount = Number(candidate.amount);
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new Error("Stripe refund amount is invalid");
      }
      total += amount;
      if (!Number.isSafeInteger(total)) {
        throw new Error("Stripe cumulative refund amount is invalid");
      }
    }
    if (!page.has_more) {
      if (expectedRefundId && !seenRefundIds.has(expectedRefundId)) {
        throw new Error("Stripe refund list does not contain the current refund");
      }
      return {
        refunds,
        cumulativeSucceededAmount: total,
      };
    }
    const lastRefund = page.data[page.data.length - 1];
    const nextCursor = stripeObjectId(lastRefund);
    if (!nextCursor || seenCursors.has(nextCursor)) {
      throw new Error("Stripe refund pagination is incomplete");
    }
    seenCursors.add(nextCursor);
    startingAfter = nextCursor;
  }
};

const enrichRefundWithCumulativeAmount = async (
  stripe,
  refund,
  { paymentIntentId = null, chargeId: fallbackChargeId = null } = {},
) => {
  let chargeId = stripeObjectId(refund.charge) || fallbackChargeId;
  if (!chargeId
    && (refund.payment_intent || paymentIntentId)
    && stripe.paymentIntents
    && typeof stripe.paymentIntents.retrieve === "function") {
    const paymentIntent = await stripe.paymentIntents.retrieve(
      stripeObjectId(refund.payment_intent) || paymentIntentId,
    );
    chargeId = stripeObjectId(paymentIntent && paymentIntent.latest_charge);
  }
  if (!chargeId) return refund;
  const refundSnapshot = await listStripeRefundsByCharge(
    stripe,
    chargeId,
    stripeObjectId(refund),
  );
  return {
    ...refund,
    charge: refund.charge || chargeId,
    cumulative_succeeded_amount: refundSnapshot.cumulativeSucceededAmount,
  };
};

const getRefundAttemptGeneration = (refund, orderId, shopId, paymentIntentId) => {
  const metadata = refund.metadata || {};
  if (String(metadata.order_id || "") !== String(orderId)
    || String(metadata.shop_id || "") !== String(shopId)) {
    return null;
  }
  const refundPaymentIntentId = stripeObjectId(refund.payment_intent);
  if (refundPaymentIntentId && refundPaymentIntentId !== paymentIntentId) return null;
  const rawGeneration = metadata.refund_attempt_generation;
  if (rawGeneration == null || rawGeneration === "") return 0;
  if (!/^\d+$/.test(String(rawGeneration))) {
    throw new Error("Stripe refund attempt generation is invalid");
  }
  const generation = Number(rawGeneration);
  if (!Number.isSafeInteger(generation)) {
    throw new Error("Stripe refund attempt generation is invalid");
  }
  return generation;
};

const refundIdempotencyKey = (shopId, orderId, generation) => (
  generation === 0
    ? `refund-order-${shopId}-${orderId}`
    : `refund-order-${shopId}-${orderId}-g${generation}`
);

const buildStripeWebhookEventHandler = ({
  handleTerminalEvent = handleTerminalWebhookEvent,
  reconcileTerminalRefund = (refund) => terminalOrderRefundService.reconcileTerminalRefund(refund),
  getStripe: getStripeClient = getStripe,
  markPaymentAttemptFailed: markAttemptFailed = markPaymentAttemptFailed,
  markPaymentCanceled: markCanceled = markPaymentCanceled,
  markPaymentProcessing: markProcessing = markPaymentProcessing,
  markPaymentSucceeded: markSucceeded = markPaymentSucceeded,
  reconcileStripeRefund: reconcileRefund = reconcileStripeRefund,
} = {}) => {
  const markSucceededWithCharge = async (paymentIntent) => {
    const charge = paymentIntent.latest_charge
      ? await getStripeClient().charges.retrieve(paymentIntent.latest_charge)
      : null;
    return markSucceeded(paymentIntent, charge);
  };

  const reconcileCurrentPaymentIntent = async (paymentIntentId) => {
    const paymentIntent = await getStripeClient().paymentIntents.retrieve(paymentIntentId);
    if (paymentIntent.status === "succeeded") {
      return markSucceededWithCharge(paymentIntent);
    }
    if (paymentIntent.status === "canceled") {
      return markCanceled(paymentIntent.id);
    }
    if (paymentIntent.status === "processing") {
      return markProcessing(paymentIntent.id);
    }
    return markAttemptFailed(paymentIntent);
  };

  return async (event) => {
    const terminalResult = await handleTerminalEvent(event);
    if (terminalResult) return terminalResult;
    const paymentIntent = event.data.object;
    if (["refund.created", "refund.updated", "refund.failed"].includes(event.type)) {
      if (Object.prototype.hasOwnProperty.call(paymentIntent.metadata || {}, "terminal_payment_id")) {
        try {
          const refund = await getStripeClient().refunds.retrieve(paymentIntent.id);
          return await reconcileTerminalRefund(refund);
        } catch (error) {
          throw new Error("Impossible de rapprocher le remboursement terminal.");
        }
      }
      const stripe = getStripeClient();
      const refund = await stripe.refunds.retrieve(event.data.object.id);
      const authoritativeRefund = await enrichRefundWithCumulativeAmount(stripe, refund);
      return reconcileRefund(authoritativeRefund);
    }
    if (event.type === "payment_intent.succeeded") {
      return markSucceededWithCharge(paymentIntent);
    }
    if (["payment_intent.payment_failed", "payment_intent.processing"].includes(event.type)) {
      return reconcileCurrentPaymentIntent(paymentIntent.id);
    }
    if (event.type === "payment_intent.canceled") {
      return markCanceled(paymentIntent.id);
    }
    return null;
  };
};

exports.buildStripeWebhookEventHandler = buildStripeWebhookEventHandler;
const handleStripeWebhookEvent = buildStripeWebhookEventHandler();

exports.handleWebhook = async (req, res) => {
  try {
    const stripe = getStripe();
    const signature = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      envSTRIPEWEBHOOKSECRET,
    );

    await handleStripeWebhookEvent(event);

    res.json({ received: true });
  } catch (error) {
    res.status(400).send(`Webhook Error: ${error.message}`);
  }
};

const buildRefundPaidOrderController = ({
  getPaidOrderForRefund: findPaidOrder = async (orderId, shopId) => {
    const payments = await getPaidOrderForRefund(orderId, shopId);
    if (payments.length) return payments;
    const orders = await mFindOrderById(orderId, shopId);
    return orders[0] && orders[0].stripe_terminal_payment_id != null ? orders : payments;
  },
  refundTerminalOrder: refundTerminal = (input) => terminalOrderRefundService.refundTerminalOrder(input),
  getStripe: getStripeClient = getStripe,
  recordRefundState: persistRefundState = recordRefundState,
} = {}) => async (req, res) => {
  try {
    const rawOrderId = req.params && req.params.id;
    if (typeof rawOrderId !== "string"
      || !/^[1-9]\d*$/.test(rawOrderId)
      || !Number.isSafeInteger(Number(rawOrderId))
      || String(Number(rawOrderId)) !== rawOrderId) {
      return custom(res, 400, "Identifiant de commande invalide.", null, {
        code: "STRIPE_REFUND_ORDER_INVALID",
        field: "order_id",
      });
    }
    const orderId = Number(rawOrderId);
    const rows = await findPaidOrder(orderId, req.shopid);

    if (!rows.length) {
      return custom(res, 404, "Commande payee introuvable.", null, null);
    }

    const payment = rows[0];
    if (payment.stripe_terminal_payment_id != null) {
      const data = await refundTerminal({ shopId: req.shopid, orderId, actorId: req.id });
      return success(res, data.refundStatus === "succeeded"
        ? "Commande remboursee." : "Demande de remboursement enregistree.", null, data);
    }
    const coherentRefunded = payment.payment_status === "refunded"
      && payment.payment_record_status === "refunded";
    const legacyUnknown = coherentRefunded
      && payment.refund_status === "legacy_unknown";
    const manualReview = () => custom(
      res,
      409,
      "Remboursement historique a verifier manuellement.",
      null,
      {
        code: "STRIPE_REFUND_LEGACY_UNKNOWN",
        refundId: payment.stripe_refund_id || null,
        refundStatus: "legacy_unknown",
        manual_review_required: true,
      },
    );
    if (coherentRefunded && !legacyUnknown && !payment.stripe_refund_id) {
      return success(res, "Commande deja remboursee.", null, {
        refundId: null,
        refundStatus: "succeeded",
        already_refunded: true,
      });
    }

    const stripe = getStripeClient();
    let refund;
    if (payment.stripe_refund_id) {
      try {
        refund = await stripe.refunds.retrieve(payment.stripe_refund_id);
      } catch (error) {
        refund = {
          id: payment.stripe_refund_id,
          status: payment.refund_status || "pending",
          failure_reason: payment.refund_failure_reason || null,
          payment_intent: payment.stripe_payment_intent_id,
          charge: payment.stripe_charge_id || null,
          metadata: {
            order_id: String(orderId),
            shop_id: String(req.shopid),
          },
        };
      }
      if (!legacyUnknown
        && refund
        && ["failed", "canceled"].includes(refund.status)) {
        refund = null;
      }
    } else if (legacyUnknown) {
      if (!payment.stripe_payment_intent_id) return manualReview();
      const listed = await stripe.refunds.list({
        payment_intent: payment.stripe_payment_intent_id,
        limit: 100,
      });
      if (listed && listed.has_more) return manualReview();
      const refunds = Array.isArray(listed && listed.data) ? listed.data : [];
      const paymentIntentId = (candidate) => (
        typeof candidate.payment_intent === "string"
          ? candidate.payment_intent
          : candidate.payment_intent && candidate.payment_intent.id
      );
      const fullCandidates = refunds.filter((candidate) => (
        paymentIntentId(candidate) === payment.stripe_payment_intent_id
        && Number(candidate.amount) === Number(payment.amount_cents)
      ));
      if (fullCandidates.length !== 1) return manualReview();
      const [candidate] = fullCandidates;
      {
        const metadata = candidate.metadata || {};
        const hasMetadata = metadata.order_id != null || metadata.shop_id != null;
        const metadataMatches = String(metadata.order_id || "") === String(orderId)
          && String(metadata.shop_id || "") === String(req.shopid);
        if (hasMetadata && !metadataMatches) return manualReview();
      }
      refund = candidate;
    }
    if (!refund) {
      let chargeId = payment.stripe_charge_id || null;
      if (!chargeId) {
        const paymentIntent = await stripe.paymentIntents.retrieve(
          payment.stripe_payment_intent_id,
        );
        chargeId = stripeObjectId(paymentIntent && paymentIntent.latest_charge);
      }
      if (!chargeId) throw new Error("Stripe payment charge is unavailable");

      const snapshot = await listStripeRefundsByCharge(stripe, chargeId);
      const attempts = snapshot.refunds.map((candidate) => ({
        refund: candidate,
        generation: getRefundAttemptGeneration(
          candidate,
          orderId,
          req.shopid,
          payment.stripe_payment_intent_id,
        ),
      })).filter(({ generation }) => generation != null);
      const activeAttempts = attempts.filter(({ refund: candidate }) => (
        ["pending", "requires_action"].includes(candidate.status)
      ));
      if (activeAttempts.length > 1) {
        throw new Error("Multiple active Stripe refund attempts found");
      }

      if (snapshot.cumulativeSucceededAmount >= Number(payment.amount_cents)) {
        const succeededAttempts = attempts.filter(({ refund: candidate }) => (
          candidate.status === "succeeded"
        )).sort((left, right) => right.generation - left.generation);
        if (!succeededAttempts.length) {
          throw new Error("Completed Stripe refund has no matching attempt");
        }
        refund = succeededAttempts[0].refund;
      } else if (activeAttempts.length === 1) {
        refund = activeAttempts[0].refund;
      } else {
        const generation = attempts.length
          ? Math.max(...attempts.map((attempt) => attempt.generation)) + 1
          : 0;
        refund = await stripe.refunds.create({
          payment_intent: payment.stripe_payment_intent_id,
          reverse_transfer: true,
          refund_application_fee: true,
          metadata: {
            order_id: String(orderId),
            shop_id: String(req.shopid),
            refund_attempt_generation: String(generation),
          },
        }, {
          idempotencyKey: refundIdempotencyKey(req.shopid, orderId, generation),
        });
      }
    }

    refund = await enrichRefundWithCumulativeAmount(stripe, refund, {
      paymentIntentId: payment.stripe_payment_intent_id,
      chargeId: payment.stripe_charge_id || null,
    });

    const persistence = await persistRefundState({
      orderId,
      shopId: req.shopid,
      refund,
    });
    let refundId = refund.id;
    let refundStatus;
    let alreadyRefunded = false;
    let partialRefund = false;
    if (persistence
      && persistence.partial_refund
      && ["pending", "requires_action", "failed", "canceled"].includes(refund.status)) {
      refundStatus = refund.status;
      partialRefund = true;
    } else if (persistence && persistence.status) {
      refundStatus = persistence.status;
      alreadyRefunded = Boolean(persistence.idempotent_replay);
    } else if (persistence && (persistence.ignored || persistence.missing)) {
      const currentRows = await findPaidOrder(orderId, req.shopid);
      const current = currentRows[0];
      if (!current) {
        return custom(res, 409, "Etat du remboursement incoherent.", null, {
          code: "STRIPE_REFUND_STATE_CONFLICT",
        });
      }
      if (current.refund_status === "legacy_unknown") {
        return custom(
          res,
          409,
          "Remboursement historique a verifier manuellement.",
          null,
          {
            code: "STRIPE_REFUND_LEGACY_UNKNOWN",
            refundId: current.stripe_refund_id || null,
            refundStatus: "legacy_unknown",
            manual_review_required: true,
          },
        );
      }
      if (current.payment_status === "refunded"
        && current.payment_record_status === "refunded") {
        refundId = current.stripe_refund_id || null;
        refundStatus = "succeeded";
        alreadyRefunded = true;
      } else if (current.stripe_refund_id === refund.id && current.refund_status) {
        refundId = current.stripe_refund_id;
        refundStatus = current.refund_status;
      } else if (current.stripe_refund_id !== refund.id
        && ["failed", "canceled"].includes(current.refund_status)
        && ["failed", "canceled"].includes(refund.status)) {
        refundId = refund.id;
        refundStatus = refund.status;
      } else {
        return custom(res, 409, "Etat du remboursement incoherent.", null, {
          code: "STRIPE_REFUND_STATE_CONFLICT",
        });
      }
    } else {
      refundStatus = refund.status;
    }
    const data = { refundId, refundStatus };
    if (alreadyRefunded) data.already_refunded = true;
    if (partialRefund) data.partial_refund = true;
    if (persistence && persistence.business_status_unchanged) {
      data.business_status_unchanged = true;
      data.orderStatus = persistence.order_status;
    }
    success(
      res,
      refundStatus === "succeeded"
        ? "Commande remboursee."
        : "Demande de remboursement enregistree.",
      null,
      data,
    );
  } catch (error) {
    failed(res, "Erreur lors du remboursement Stripe.");
  }
};

exports.buildMarkQrTablePaymentAtCounter = buildMarkQrTablePaymentAtCounter;
exports.markQrTablePaymentAtCounter = buildMarkQrTablePaymentAtCounter();

exports.buildRefundPaidOrderController = buildRefundPaidOrderController;
exports.refundPaidOrder = buildRefundPaidOrderController();

const buildTerminalOrderRefundService = ({
  getStripe: getStripeClient = getStripe,
  terminalStore,
  findOrderById = mFindOrderById,
} = {}) => {
  const context = async (shopId, orderId) => {
    const [order] = await findOrderById(orderId, shopId);
    if (!order || Number(order.shopid) !== shopId || Number(order.id) !== orderId
      || order.stripe_terminal_payment_id == null
      || !["paid", "refund_pending", "refunded"].includes(order.payment_status)) throw new Error("Invalid Terminal order");
    const paymentId = Number(order.stripe_terminal_payment_id);
    const store = terminalStore || getTerminalStore();
    const payment = await store.findPaymentSession({ shopId, paymentId });
    const allocation = await store.findOrderAllocation({ shopId, orderId, paymentId });
    if (!payment || payment.status !== "succeeded" || !payment.stripe_payment_intent_id || !payment.stripe_connected_account_id
      || Number(payment.shopid) !== shopId || Number(payment.id) !== paymentId
      || !allocation || !Number.isSafeInteger(allocation.amount_cents) || allocation.amount_cents < 0
      || Number(allocation.shopid) !== shopId || Number(allocation.order_id) !== orderId
      || Number(allocation.terminal_payment_id) !== paymentId) throw new Error("Invalid Terminal allocation");
    return { store, payment, allocation, scope: { shopId, orderId, paymentId } };
  };
  const validateOwnership = async ({ payment, scope }) => {
    const intent = await getStripeClient().paymentIntents.retrieve(payment.stripe_payment_intent_id);
    if (!intent || intent.id !== payment.stripe_payment_intent_id || intent.status !== "succeeded"
      || intent.amount !== payment.amount_cents || intent.currency !== payment.currency
      || stripeObjectId(intent.on_behalf_of) !== payment.stripe_connected_account_id
      || stripeObjectId(intent.transfer_data && intent.transfer_data.destination) !== payment.stripe_connected_account_id
      || !intent.metadata || intent.metadata.shop_id !== String(scope.shopId)
      || intent.metadata.terminal_payment_id !== String(scope.paymentId)) {
      throw new Error("Terminal payment ownership mismatch");
    }
  };
  const dto = (allocation) => ({ refundId: allocation.stripe_refund_id, refundStatus: allocation.refund_status });
  const persist = async ({ scope, store }, refund, generation, authoritative) => dto(await retryTerminalTransaction(
    store.withTransaction,
    (transaction) => transaction.recordOrderRefund({ ...scope, generation,
      refundId: refund.id, refundStatus: refund.status, authoritative }),
  ));
  const validateRefund = ({ scope, payment, allocation }, refund) => {
    const metadata = refund && refund.metadata || {};
    const generation = Number(metadata.refund_attempt_generation);
    if (!refund || !refund.id || metadata.shop_id !== String(scope.shopId)
      || metadata.order_id !== String(scope.orderId) || metadata.terminal_payment_id !== String(scope.paymentId)
      || !Number.isSafeInteger(generation) || generation < 0 || String(generation) !== metadata.refund_attempt_generation
      || refund.amount !== allocation.amount_cents || stripeObjectId(refund.payment_intent) !== payment.stripe_payment_intent_id
      || refund.currency !== payment.currency
      || !["succeeded", "pending", "requires_action", "failed", "canceled"].includes(refund.status)) {
      throw new Error("Terminal refund mismatch");
    }
    return generation;
  };
  const reconcileTerminalRefund = async (refund) => {
    try {
      const metadata = refund.metadata || {};
      const shopId = Number(metadata.shop_id);
      const orderId = Number(metadata.order_id);
      if (![shopId, orderId].every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error("Invalid refund scope");
      const current = await context(shopId, orderId);
      const generation = validateRefund(current, refund);
      await validateOwnership(current);
      return await persist(current, refund, generation, true);
    } catch (error) {
      throw new DomainError(502, "TERMINAL_REFUND_FAILED", "Impossible de confirmer le remboursement terminal.");
    }
  };
  const refundTerminalOrder = async ({ shopId, orderId, actorId }) => {
    try {
      if (![shopId, orderId, actorId].every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)) {
        throw new Error("Invalid refund scope");
      }
      shopId = Number(shopId);
      orderId = Number(orderId);
      const current = await context(shopId, orderId);
      const { store, payment, allocation, scope } = current;
      const { paymentId } = scope;
      await validateOwnership(current);

      // Serialize provider work across processes, but release row locks before
      // Stripe calls. Webhooks can still reconcile while an HTTP call is pending.
      const result = await store.withOrderRefundLock(scope, async (lockedStore) => {
        const { attempt, matched } = await retryTerminalTransaction(lockedStore.withTransaction,
          (transaction) => transaction.reserveOrderRefund({ ...scope, generation: allocation.refund_generation,
            observedStatus: allocation.refund_status }));
        // A stale observer may report the current attempt, never create for it.
        if (!matched) return dto(attempt);
        const generation = attempt.refund_generation;
        const locked = { ...current, store: lockedStore };
        if (allocation.amount_cents === 0) return persist(locked, { id: null, status: "succeeded" }, generation, false);
        const stripe = getStripeClient();
        const metadata = { shop_id: String(shopId), order_id: String(orderId), terminal_payment_id: String(paymentId),
          refund_attempt_generation: String(generation) };
        const matches = (refund) => Object.keys(metadata).every((key) => (refund.metadata || {})[key] === metadata[key]);
        let refund = attempt.stripe_refund_id ? await stripe.refunds.retrieve(attempt.stripe_refund_id) : null;
        if (attempt.stripe_refund_id && (!refund || refund.id !== attempt.stripe_refund_id)) {
          throw new Error("Terminal refund identity mismatch");
        }
        let cursor;
        const seen = new Set();
        // Recover the refund from Stripe even after its idempotency cache expires.
        while (!attempt.stripe_refund_id) {
          const page = await stripe.refunds.list({ payment_intent: payment.stripe_payment_intent_id, limit: 100,
            ...(cursor ? { starting_after: cursor } : {}) });
          if (!page || !Array.isArray(page.data) || typeof page.has_more !== "boolean") throw new Error("Invalid refund list");
          for (const candidate of page.data) {
            if (!candidate.id || seen.has(candidate.id)) throw new Error("Invalid refund page");
            seen.add(candidate.id);
            if (matches(candidate)) {
              if (refund) throw new Error("Ambiguous Terminal refund");
              refund = candidate;
            }
          }
          if (!page.has_more) break;
          if (!page.data.length) throw new Error("Incomplete refund page");
          cursor = page.data[page.data.length - 1].id;
        }
        const authoritative = Boolean(refund);
        if (!refund) refund = await stripe.refunds.create({
          payment_intent: payment.stripe_payment_intent_id, amount: allocation.amount_cents,
          reverse_transfer: true, refund_application_fee: true, metadata,
        }, { idempotencyKey: `terminal-refund:${shopId}:${paymentId}:${orderId}:g${generation}` });
        if (validateRefund(current, refund) !== generation) throw new Error("Terminal refund generation mismatch");
        return persist(locked, refund, generation, authoritative);
      });
      if (result) return result;
      const attempt = await store.findOrderAllocation(scope);
      if (!attempt) throw new Error("Missing Terminal refund attempt");
      return dto(attempt);
    } catch (error) {
      throw new DomainError(502, "TERMINAL_REFUND_FAILED", "Impossible de confirmer le remboursement terminal.");
    }
  };
  return { refundTerminalOrder, reconcileTerminalRefund };
};

const terminalOrderRefundService = buildTerminalOrderRefundService();
exports.buildTerminalOrderRefundService = buildTerminalOrderRefundService;
exports.refundTerminalOrder = terminalOrderRefundService.refundTerminalOrder;
