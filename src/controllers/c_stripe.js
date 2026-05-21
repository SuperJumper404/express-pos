const { getStripe } = require("../config/stripe");
const {
  envSTRIPECOMMISSIONPERCENT,
  envSTRIPEPUBLISHABLEKEY,
  envSTRIPEREFRESHURL,
  envSTRIPERETURNURL,
  envSTRIPEWEBHOOKSECRET,
  envSTRIPEPAYMENTMETHODCONFIGURATIONID,
} = require("../helpers/env");
const { isMissing, parseMoney } = require("../helpers/money");
const { custom, failed, success } = require("../helpers/response");
const { isStripeRequiredBeforeOrder } = require("../helpers/qrPaymentMode");
const {
  buildDestinationPaymentIntentParams,
  toStripeAmount,
} = require("../helpers/stripePayment");
const {
  mGetShopInfo,
  mUpdateStripeAccount,
} = require("../modules/m_shop");
const {
  attachPaymentIntentToOrder,
  createPaymentRecord,
  createPendingStripeOrder,
  getPaidOrderForRefund,
  markPaymentFailed,
  markPaymentRefunded,
  markPaymentSucceeded,
} = require("../modules/m_payments");

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const makeOrderNumber = () => {
  const timestamp = new Date().valueOf().toString();
  const randomValue = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, "0");
  return (timestamp + randomValue).slice(-4);
};

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

exports.createQrTablePaymentIntent = async (req, res) => {
  try {
    const body = req.body || {};
    const subtotal = parseMoney(body.subtotal);
    const details = Array.isArray(body.items) ? body.items : [];

    if (
      !body.customer ||
      isMissing(body.subtotal) ||
      subtotal === null ||
      !body.customerID ||
      details.length === 0
    ) {
      return custom(res, 400, "Requete paiement invalide.", null, null);
    }

    const rows = await mGetShopInfo(req.shopid);
    const shop = rows[0];
    if (!shop) {
      return custom(res, 404, "Restaurant introuvable.", null, null);
    }

    if ([true, 1, "1", "true"].includes(shop.kitchen_closed)) {
      return custom(res, 422, "La cuisine est fermee.", null, null);
    }

    if (!isStripeRequiredBeforeOrder(shop.qr_payment_mode)) {
      return custom(
        res,
        422,
        "Le paiement Stripe avant commande n'est pas actif pour ce restaurant.",
        null,
        null,
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
        null,
      );
    }

    const order = {
      ordernumber: makeOrderNumber(),
      customer: body.customer,
      customerID: body.customerID,
      operator: body.operator || null,
      subtotal,
      payment: "Stripe",
      payment_status: "requires_payment",
      payment_provider: "stripe",
      remark: body.remark,
      phone: body.phone,
      status: 0,
      created: now(),
      finished: now(),
      shopid: req.shopid,
    };
    const orderDetails = details.map((item) => ({
      productid: item.productid || item.id,
      price: parseMoney(item.price),
      qty: item.qty,
      total: parseMoney(item.total),
      customizationList: item.customizationList,
    }));

    const invalidDetail = orderDetails.some(
      (item) =>
        !item.productid ||
        item.price === null ||
        !item.qty ||
        item.total === null,
    );
    if (invalidDetail) {
      return custom(res, 400, "Details de commande invalides.", null, null);
    }

    const orderResult = await createPendingStripeOrder({
      order,
      details: orderDetails,
    });

    const stripeParams = buildDestinationPaymentIntentParams({
      amount: subtotal,
      currency: "eur",
      connectedAccountId: shop.stripe_account_id,
      orderId: orderResult.insertId,
      shopId: req.shopid,
      commissionPercent: envSTRIPECOMMISSIONPERCENT,
      paymentMethodConfigurationId: envSTRIPEPAYMENTMETHODCONFIGURATIONID,
    });

    const paymentIntent = await getStripe().paymentIntents.create(stripeParams);
    await attachPaymentIntentToOrder(orderResult.insertId, paymentIntent.id);
    await createPaymentRecord({
      order_id: orderResult.insertId,
      shop_id: req.shopid,
      stripe_payment_intent_id: paymentIntent.id,
      amount: subtotal,
      amount_cents: toStripeAmount(subtotal),
      application_fee_amount: stripeParams.application_fee_amount,
      currency: stripeParams.currency,
      status: paymentIntent.status,
    });

    success(res, "Paiement Stripe cree.", null, {
      orderId: orderResult.insertId,
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      publishableKey: envSTRIPEPUBLISHABLEKEY,
    });
  } catch (error) {
    failed(res, "Erreur lors de la creation du paiement Stripe.", error.message);
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
      event.type === "payment_intent.payment_failed" ||
      event.type === "payment_intent.canceled"
    ) {
      await markPaymentFailed(event.data.object.id);
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
