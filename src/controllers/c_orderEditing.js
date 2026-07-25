const DomainError = require("../helpers/domainError");
const { getStripe } = require("../config/stripe");
const { custom } = require("../helpers/response");
const {
  amendOrder,
  getEditableOrder,
} = require("../modules/m_orderEditing");
const {
  markPaymentSucceeded,
  recoverCanceledEditPayment,
  rotatePaymentReplacementAttempt,
  stagePaymentReplacement,
} = require("../modules/m_payments");
const regenerateOrderPaymentIntent = (...args) => (
  require("./c_stripe").regenerateOrderPaymentIntent(...args)
);

const domainResponse = (res, error) => custom(
  res,
  error.status,
  error.message,
  null,
  Object.keys(error).reduce((data, key) => {
    if (!["status", "code", "message", "name"].includes(key)) data[key] = error[key];
    return data;
  }, { code: error.code }),
);

const invalidRequest = (field) => new DomainError(
  400,
  "ORDER_EDIT_REQUEST_INVALID",
  "Requete de modification invalide.",
  { field },
);

const allowedKeys = (value, keys) => (
  value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => keys.has(key))
);

const normalizeAmendBody = (body) => {
  const topLevelKeys = new Set(["content_revision", "expected_total", "items"]);
  if (!allowedKeys(body, topLevelKeys)) throw invalidRequest("body");
  if (!Array.isArray(body.items)) throw invalidRequest("items");
  const itemKeys = new Set([
    "product_id",
    "quantity",
    "selected_product_step_choice_ids",
  ]);
  const items = body.items.map((item, index) => {
    if (!allowedKeys(item, itemKeys)) throw invalidRequest(`items.${index}`);
    const selectedChoiceIds = item.selected_product_step_choice_ids;
    if (selectedChoiceIds != null && !Array.isArray(selectedChoiceIds)) {
      throw invalidRequest(`items.${index}.selected_product_step_choice_ids`);
    }
    return {
      productId: Number(item.product_id),
      quantity: Number(item.quantity),
      selectedChoiceIds: selectedChoiceIds == null
        ? []
        : selectedChoiceIds.map(Number),
    };
  });
  return {
    contentRevision: body.content_revision,
    expectedTotal: body.expected_total,
    items,
  };
};

const buildOrderEditingController = ({
  getEditableOrder: getOrder = getEditableOrder,
  logger = console,
} = {}) => async (req, res) => {
  try {
    const order = await getOrder({
      orderId: req.params.id,
      shopId: req.shopid,
    });
    if (!order) {
      return custom(res, 404, "Commande introuvable.", null, null);
    }
    return custom(res, 200, "Commande editable recuperee.", null, order);
  } catch (error) {
    if (error instanceof DomainError) return domainResponse(res, error);
    logger.error("Editable order read failed", error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

const buildAmendOrderController = ({
  amendOrder: amend = amendOrder,
  getStripe: getStripeClient = getStripe,
  markPaymentSucceeded: syncSucceededPayment = markPaymentSucceeded,
  recoverCanceledEditPayment: recoverCanceledPayment = recoverCanceledEditPayment,
  rotatePaymentReplacementAttempt: rotateReplacement = rotatePaymentReplacementAttempt,
  stagePaymentReplacement: stageReplacement = stagePaymentReplacement,
  regenerateOrderPaymentIntent: regeneratePayment = regenerateOrderPaymentIntent,
  logger = console,
} = {}) => async (req, res) => {
  const orderId = Number(req.params.id);
  const shopId = Number(req.shopid);
  let canceledPaymentIntentId = null;
  let succeededPaymentIntent = null;
  let replacementAttemptToken = null;
  let transactionCommitted = false;
  try {
    const normalized = normalizeAmendBody(req.body || {});
    const result = await amend({
      orderId,
      shopId,
      operatorId: Number(req.id),
      ...normalized,
      prepareStripeReplacement: async ({ order, connection }) => {
        if (order.payment_status === "unpaid" && !order.stripe_payment_intent_id) {
          const rotated = await rotateReplacement({
            orderId: order.id,
            shopId: order.shopid,
            currentAttemptToken: order.stripe_replacement_attempt_token || null,
            connection,
          });
          if (!rotated || !rotated.ready) {
            throw new DomainError(
              409,
              "ORDER_EDIT_CONFLICT",
              "La commande a change.",
            );
          }
          replacementAttemptToken = rotated.replacement_attempt_token;
          return;
        }

        const paymentIntentId = order.stripe_payment_intent_id;
        if (order.payment_status !== "requires_payment" || !paymentIntentId) {
          throw new DomainError(
            409,
            "STRIPE_PAYMENT_NOT_SETTLED",
            "Le paiement Stripe ne peut pas etre remplace.",
          );
        }
        let paymentIntent;
        try {
          paymentIntent = await getStripeClient().paymentIntents.retrieve(paymentIntentId);
        } catch (error) {
          throw new DomainError(
            409,
            "STRIPE_PAYMENT_NOT_SETTLED",
            "Le paiement Stripe ne peut pas etre verifie.",
          );
        }
        if (paymentIntent.status === "succeeded") {
          succeededPaymentIntent = paymentIntent;
          throw new DomainError(
            409,
            "STRIPE_PAYMENT_ALREADY_SUCCEEDED",
            "Le paiement est deja confirme par Stripe.",
          );
        }
        if (paymentIntent.status !== "canceled") {
          try {
            paymentIntent = await getStripeClient().paymentIntents.cancel(paymentIntentId);
          } catch (error) {
            throw new DomainError(
              409,
              "STRIPE_PAYMENT_NOT_SETTLED",
              "Le paiement Stripe ne peut pas etre annule.",
            );
          }
        }
        if (!paymentIntent || paymentIntent.status !== "canceled") {
          throw new DomainError(
            409,
            "STRIPE_PAYMENT_NOT_SETTLED",
            "Le paiement Stripe n'est pas annule.",
          );
        }
        canceledPaymentIntentId = paymentIntentId;
        const staged = await stageReplacement({
          orderId: order.id,
          shopId: order.shopid,
          paymentIntentId,
          connection,
        });
        if (!staged || !staged.ready) {
          throw new DomainError(
            409,
            "STRIPE_PAYMENT_NOT_SETTLED",
            "Le remplacement du paiement Stripe a echoue.",
          );
        }
        replacementAttemptToken = staged.replacement_attempt_token;
      },
    });
    transactionCommitted = true;
    if (!replacementAttemptToken || result.canceled) {
      return custom(res, 200, "Commande modifiee avec succes.", null, result);
    }
    try {
      const payment = await regeneratePayment({
        order: {
          id: result.order_id,
          shopid: shopId,
          subtotal: result.total,
          payment_provider: "stripe",
          payment_status: "unpaid",
          stripe_payment_intent_id: null,
          stripe_replacement_attempt_token: replacementAttemptToken,
        },
        contentRevision: result.content_revision,
      });
      return custom(res, 200, "Commande modifiee avec succes.", null, {
        ...result,
        payment_status: "requires_payment",
        payment_refresh: "succeeded",
        payment,
      });
    } catch (error) {
      logger.error("Stripe replacement PaymentIntent creation failed", error);
      return custom(res, 200, "Commande modifiee avec succes.", null, {
        ...result,
        payment_status: "unpaid",
        payment_refresh: "required",
        payment_refresh_message: "Le paiement Stripe doit etre regenere.",
      });
    }
  } catch (error) {
    if (succeededPaymentIntent) {
      try {
        await syncSucceededPayment(succeededPaymentIntent);
      } catch (syncError) {
        logger.error("Succeeded Stripe edit payment synchronization failed", syncError);
        return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
      }
      error = new DomainError(
        409,
        "ORDER_NOT_EDITABLE",
        "Cette commande est deja encaissee.",
        { payment_status: "paid" },
      );
    }
    if (canceledPaymentIntentId && !transactionCommitted) {
      try {
        await recoverCanceledPayment({ orderId, shopId, paymentIntentId: canceledPaymentIntentId });
      } catch (recoveryError) {
        logger.error("Canceled Stripe edit payment recovery failed", recoveryError);
      }
      error.payment_refresh = "required";
      error.payment_refresh_message = "Rechargez la commande avant de reessayer.";
    }
    if (error instanceof DomainError) return domainResponse(res, error);
    logger.error("Transactional order amendment failed", error);
    return custom(res, 500, "Erreur serveur.", null, {
      code: "INTERNAL_ERROR",
      ...(canceledPaymentIntentId && {
        payment_refresh: "required",
        payment_refresh_message: "Rechargez la commande avant de reessayer.",
      }),
    });
  }
};

const buildReplacementPaymentController = ({
  getEditableOrder: getOrder = getEditableOrder,
  regenerateOrderPaymentIntent: regeneratePayment = regenerateOrderPaymentIntent,
  logger = console,
} = {}) => async (req, res) => {
  try {
    const editable = await getOrder({
      orderId: Number(req.params.id),
      shopId: Number(req.shopid),
    });
    if (!editable) return custom(res, 404, "Commande introuvable.", null, null);
    const order = editable.order;
    if (order.payment_provider !== "stripe"
      || !["unpaid", "requires_payment"].includes(order.payment_status)) {
      throw new DomainError(
        409,
        "ORDER_NOT_EDITABLE",
        "Le paiement de cette commande ne peut pas etre regenere.",
      );
    }
    const payment = await regeneratePayment({
      order,
      contentRevision: editable.content_revision,
    });
    return custom(res, 200, "Paiement Stripe regenere.", null, payment);
  } catch (error) {
    if (error instanceof DomainError) return domainResponse(res, error);
    logger.error("Stripe replacement PaymentIntent retry failed", error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

module.exports = {
  buildAmendOrderController,
  buildOrderEditingController,
  buildReplacementPaymentController,
  amendOrder: buildAmendOrderController(),
  getEditableOrder: buildOrderEditingController(),
  replacementPayment: buildReplacementPaymentController(),
  normalizeAmendBody,
};
