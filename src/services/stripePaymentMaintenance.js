const { getStripe } = require("../config/stripe");
const { releaseExpiredReservations } = require("../modules/m_checkout");
const {
  findExpiredStripePayments,
  markPaymentCanceled,
  markPaymentSucceeded,
} = require("../modules/m_payments");

const buildStripePaymentMaintenance = ({
  findExpiredStripePayments: findExpiredPayments,
  getStripe: getStripeClient,
  markPaymentSucceeded: markSucceeded,
  markPaymentCanceled: markCanceled,
  releaseExpiredReservations: releaseExpired,
  logger = console,
  now = () => new Date(),
}) => async () => {
  const expiredPayments = await findExpiredPayments(now());

  for (const payment of expiredPayments) {
    let stripeStatus = null;
    try {
      const stripe = getStripeClient();
      const paymentIntent = await stripe.paymentIntents.retrieve(
        payment.stripe_payment_intent_id,
      );
      stripeStatus = paymentIntent.status;

      if (paymentIntent.status === "succeeded") {
        const charge = paymentIntent.latest_charge
          ? await stripe.charges.retrieve(paymentIntent.latest_charge)
          : null;
        await markSucceeded(paymentIntent, charge);
        continue;
      }

      if (paymentIntent.status === "processing") {
        logger.info("Stripe payment maintenance left processing payment reserved", {
          order_id: payment.order_id,
          shop_id: payment.shop_id,
          stripe_payment_intent_id: payment.stripe_payment_intent_id,
          stripe_status: paymentIntent.status,
        });
        continue;
      }

      if (paymentIntent.status === "canceled") {
        await markCanceled(payment.stripe_payment_intent_id);
        continue;
      }

      const canceledPaymentIntent = await stripe.paymentIntents.cancel(
        payment.stripe_payment_intent_id,
      );
      stripeStatus = canceledPaymentIntent && canceledPaymentIntent.status;
      if (stripeStatus !== "canceled") {
        throw new Error("Stripe did not confirm PaymentIntent cancellation");
      }
      await markCanceled(payment.stripe_payment_intent_id);
    } catch (error) {
      logger.error("Stripe payment maintenance item failed", {
        order_id: payment.order_id,
        shop_id: payment.shop_id,
        stripe_payment_intent_id: payment.stripe_payment_intent_id,
        stripe_status: stripeStatus,
        message: error.message,
      });
    }
  }

  return releaseExpired();
};

const runStripePaymentMaintenance = buildStripePaymentMaintenance({
  findExpiredStripePayments,
  getStripe,
  markPaymentSucceeded,
  markPaymentCanceled,
  releaseExpiredReservations,
});

module.exports = {
  buildStripePaymentMaintenance,
  runStripePaymentMaintenance,
};
