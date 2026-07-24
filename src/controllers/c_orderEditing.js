const DomainError = require("../helpers/domainError");
const { getStripe } = require("../config/stripe");
const { parseMoney } = require("../helpers/money");
const { custom, success } = require("../helpers/response");
const {
  getEditableOrder,
  prepareOrderPaymentRegeneration,
  previewOrderEdit,
  updateOrderItems,
} = require("../modules/m_orderEditing");
const {
  markPaymentSucceeded,
  recoverCanceledEditPayment,
  stagePaymentReplacement,
} = require("../modules/m_payments");
const {
  regenerateOrderPaymentIntent,
} = require("./c_stripe");

const domainResponse = (res, error) => custom(
  res,
  error.status,
  error.message,
  null,
  Object.keys(error).reduce((data, key) => {
    if (!["status", "message", "name"].includes(key)) data[key] = error[key];
    return data;
  }, { code: error.code }),
);

const buildGetEditableOrderController = ({
  getEditableOrder: loadEditableOrder = getEditableOrder,
} = {}) => async (req, res) => {
  try {
    const data = await loadEditableOrder({
      orderId: Number(req.params.id),
      shopId: Number(req.shopid),
    });
    return success(res, "Commande modifiable récupérée.", null, data);
  } catch (error) {
    if (error instanceof DomainError) return domainResponse(res, error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

const buildUpdateOrderItemsController = ({
  updateOrderItems: saveOrderItems = updateOrderItems,
  previewOrderEdit: previewItems = previewOrderEdit,
  getStripe: getStripeClient = getStripe,
  stagePaymentReplacement: stageReplacement = stagePaymentReplacement,
  recoverCanceledEditPayment: recoverCanceledPayment = recoverCanceledEditPayment,
  markPaymentSucceeded: syncSucceededPayment = markPaymentSucceeded,
  regenerateOrderPaymentIntent: regeneratePayment = regenerateOrderPaymentIntent,
  logger = console,
} = {}) => async (req, res) => {
  const input = {
    orderId: Number(req.params.id),
    shopId: Number(req.shopid),
    actorId: Number(req.id),
    contentRevision: req.body.content_revision,
    expectedTotal: req.body.expected_total,
    items: req.body.items,
  };
  let canceledPaymentIntentId = null;
  let succeededPaymentIntent = null;
  let transactionCommitted = false;
  let stripePaymentReplaced = false;
  try {
    const preview = await previewItems({
      shopId: input.shopId,
      items: input.items,
    });
    if (parseMoney(input.expectedTotal) !== preview.total) {
      throw new DomainError(
        409,
        "ORDER_REPRICE_REQUIRED",
        "Le prix de la commande a changé.",
        { server_quote: preview },
      );
    }

    const settlePendingPayment = async ({ order, connection }) => {
      const paymentIntentId = order.stripe_payment_intent_id;
      if (!paymentIntentId) {
        throw new DomainError(
          409,
          "STRIPE_PAYMENT_NOT_SETTLED",
          "Le paiement Stripe ne peut pas être remplacé.",
        );
      }

      let paymentIntent;
      try {
        paymentIntent = await getStripeClient().paymentIntents.retrieve(paymentIntentId);
      } catch (error) {
        throw new DomainError(
          409,
          "STRIPE_PAYMENT_NOT_SETTLED",
          "Le paiement Stripe ne peut pas être vérifié.",
        );
      }
      if (paymentIntent.status === "succeeded") {
        succeededPaymentIntent = paymentIntent;
        throw new DomainError(
          409,
          "STRIPE_PAYMENT_ALREADY_SUCCEEDED",
          "Le paiement est déjà confirmé par Stripe.",
        );
      }

      if (paymentIntent.status !== "canceled") {
        try {
          paymentIntent = await getStripeClient().paymentIntents.cancel(paymentIntentId);
        } catch (error) {
          throw new DomainError(
            409,
            "STRIPE_PAYMENT_NOT_SETTLED",
            "Le paiement Stripe ne peut pas être annulé.",
          );
        }
      }
      if (!paymentIntent || paymentIntent.status !== "canceled") {
        throw new DomainError(
          409,
          "STRIPE_PAYMENT_NOT_SETTLED",
          "Le paiement Stripe n'est pas annulé.",
        );
      }

      canceledPaymentIntentId = paymentIntentId;
      const staged = await stageReplacement({
        orderId: order.id,
        shopId: order.shopid,
        paymentIntentId,
        connection,
        order,
      });
      if (!staged || !staged.ready) {
        throw new DomainError(
          409,
          "STRIPE_PAYMENT_NOT_SETTLED",
          "Le remplacement du paiement Stripe a échoué.",
        );
      }
      order.payment_status = "unpaid";
      order.stripe_payment_intent_id = null;
      stripePaymentReplaced = true;
    };

    const data = await saveOrderItems({ ...input, settlePendingPayment });
    transactionCommitted = true;
    if (!stripePaymentReplaced) {
      return success(res, "Commande modifiée avec succès.", null, data);
    }

    try {
      const payment = await regeneratePayment({
        order: {
          id: data.order_id,
          shopid: input.shopId,
          subtotal: data.total,
        },
        contentRevision: data.content_revision,
      });
      return success(res, "Commande modifiée avec succès.", null, {
        ...data,
        payment_status: "requires_payment",
        payment_refresh: "succeeded",
        payment,
      });
    } catch (error) {
      logger.error("Stripe replacement PaymentIntent creation failed", error);
      return success(res, "Commande modifiée avec succès.", null, {
        ...data,
        payment_status: "unpaid",
        payment_refresh: "required",
        payment_refresh_message: "Le paiement Stripe doit être régénéré.",
      });
    }
  } catch (error) {
    if (succeededPaymentIntent) {
      try {
        await syncSucceededPayment(succeededPaymentIntent);
      } catch (syncError) {
        logger.error("Succeeded Stripe edit payment synchronization failed", syncError);
        return custom(res, 500, "Erreur serveur.", null, {
          code: "INTERNAL_ERROR",
        });
      }
      error = new DomainError(
        409,
        "ORDER_NOT_EDITABLE",
        "Cette commande est déjà encaissée.",
        { payment_status: "paid" },
      );
    }

    if (canceledPaymentIntentId && !transactionCommitted) {
      try {
        await recoverCanceledPayment({
          orderId: input.orderId,
          shopId: input.shopId,
          paymentIntentId: canceledPaymentIntentId,
        });
      } catch (recoveryError) {
        logger.error("Canceled Stripe edit payment recovery failed", recoveryError);
      }
      error.payment_refresh = "required";
      error.payment_refresh_message = "Rechargez la commande avant de réessayer.";
    }
    if (error instanceof DomainError) return domainResponse(res, error);
    return custom(res, 500, "Erreur serveur.", null, {
      code: "INTERNAL_ERROR",
      ...(canceledPaymentIntentId && {
        payment_refresh: "required",
        payment_refresh_message: "Rechargez la commande avant de réessayer.",
      }),
    });
  }
};

const buildRegenerateOrderPaymentIntentController = ({
  prepareOrderPaymentRegeneration: preparePayment = prepareOrderPaymentRegeneration,
  regenerateOrderPaymentIntent: regeneratePayment = regenerateOrderPaymentIntent,
} = {}) => async (req, res) => {
  try {
    const prepared = await preparePayment({
      orderId: Number(req.params.id),
      shopId: Number(req.shopid),
    });
    const payment = await regeneratePayment({
      order: prepared.order,
      contentRevision: prepared.contentRevision,
    });
    return success(res, "Paiement Stripe régénéré.", null, payment);
  } catch (error) {
    if (error instanceof DomainError) return domainResponse(res, error);
    return custom(res, 500, "Erreur serveur.", null, { code: "INTERNAL_ERROR" });
  }
};

module.exports = {
  buildGetEditableOrderController,
  buildRegenerateOrderPaymentIntentController,
  buildUpdateOrderItemsController,
  getEditableOrder: buildGetEditableOrderController(),
  regenerateOrderPaymentIntent: buildRegenerateOrderPaymentIntentController(),
  updateOrderItems: buildUpdateOrderItemsController(),
};
