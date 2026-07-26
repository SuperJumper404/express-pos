const {
  mAllOrder,
  mDetailOrder,
  mAddOrders,
  mAddDetailOrder,
  mReduceStock,
  mAddNewStocks,
  mDeleteOrder,
  mOrdersbyUserId,
  mArchiveOrder,
  mFindOrderById,
  mAllArchivedOrders,
  mDetailArchivedOrder,
  mDetailArchivedOrderByToken,
  mAllArchivedOrdersWithDetails,
} = require("../modules/m_orders");

const { custom, success, failed } = require("../helpers/response");
const DomainError = require("../helpers/domainError");
const { envJWTKEY } = require("../helpers/env");
const { isMissing, parseMoney } = require("../helpers/money");
const { ORDER_STATUSES } = require("../helpers/orderStatus");
const { buildOrderDetailStockEntry } = require("../helpers/orderDetailStock");
const {
  shouldCancelPendingStripePayment,
} = require("../helpers/cashRegisterPayment");
const { getStripe } = require("../config/stripe");
const {
  markPaymentCanceled,
  markPaymentSucceeded,
  markStripeOrderPayAtCounter,
} = require("../modules/m_payments");
const {
  buildCheckoutController,
  createCheckout,
} = require("../modules/m_checkout");
const {
  transitionOrderStatus,
} = require("../modules/m_orderTransitions");

const jwt = require("jsonwebtoken");
const response = require("../helpers/response");
const { mGetShopInfo } = require("../modules/m_shop");

exports.checkout = buildCheckoutController({
  checkout: { createCheckout },
});

const moneyOrZero = (value) => {
  const parsed = parseMoney(value);
  return parsed === null ? 0 : parsed;
};

const hasPendingStripePayment = (order = {}) =>
  order.payment_provider === "stripe" &&
  order.payment_status === "requires_payment" &&
  order.stripe_payment_intent_id;

const stripePaymentNotSettledError = () => new DomainError(
  409,
  "STRIPE_PAYMENT_NOT_SETTLED",
  "Le paiement Stripe ne peut pas etre confirme pour cette commande.",
);

const cancelPendingStripePayment = async (order) => {
  if (!hasPendingStripePayment(order)) return;

  const stripe = getStripe();
  const paymentIntentId = order.stripe_payment_intent_id;
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status === "succeeded") {
    throw new Error("Le paiement est deja confirme par Stripe.");
  }

  if (paymentIntent.status !== "canceled") {
    await stripe.paymentIntents.cancel(paymentIntentId);
  }

  return paymentIntentId;
};

const buildPendingStripeArchiveSync = ({
  getStripe: getStripeClient = getStripe,
  markPaymentSucceeded: commitSucceededPayment = markPaymentSucceeded,
  markStripeOrderPayAtCounter: commitPayAtCounter = markStripeOrderPayAtCounter,
  findOrderById = mFindOrderById,
} = {}) => async (order) => {
  if (!shouldCancelPendingStripePayment(order)) {
    if (order.payment_provider === "stripe" && order.payment_status !== "paid") {
      throw new Error("Commande Stripe annulee ou echouee non encaissable");
    }
    return order;
  }

  const stripe = getStripeClient();
  const paymentIntentId = order.stripe_payment_intent_id;
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  if (paymentIntent.status === "succeeded") {
    const charge = paymentIntent.latest_charge
      ? await stripe.charges.retrieve(paymentIntent.latest_charge)
      : null;
    const transition = await commitSucceededPayment(paymentIntent, charge);
    if (!transition || (!transition.paid && !transition.alreadyPaid)) {
      throw stripePaymentNotSettledError();
    }

    const refreshedOrders = await findOrderById(order.id, order.shopid);
    const refreshedOrder = refreshedOrders[0];
    if (!refreshedOrder || refreshedOrder.payment_status !== "paid") {
      throw stripePaymentNotSettledError();
    }
    return refreshedOrder;
  }

  if (paymentIntent.status !== "canceled") {
    await stripe.paymentIntents.cancel(paymentIntentId);
  }

  const transition = await commitPayAtCounter(order.id, order.shopid, paymentIntentId);
  if (!transition || transition.ignored) {
    throw stripePaymentNotSettledError();
  }
  const refreshedOrders = await findOrderById(order.id, order.shopid);
  return refreshedOrders[0] || order;
};

const syncPendingStripeBeforeCashRegisterArchive = buildPendingStripeArchiveSync();
exports.buildPendingStripeArchiveSync = buildPendingStripeArchiveSync;

exports.allOrder = async (req, res) => {
  mAllOrder(req.shopid)
    .then((response) => {
      success(res, "Commandes récupérées.", null, response);
    })
    .catch((error) => {
      failed(res, "Erreur serveur.", error.message);
    });
};
exports.ordersbyUserId = async (req, res) => {
  const userId = req.query.userId;
  mOrdersbyUserId(userId)
    .then((response) => {
      success(res, "Commandes récupérées.", null, response);
    })
    .catch((error) => {
      failed(res, "Erreur serveur.", error.message);
    });
};
exports.detailOrder = (req, res) => {
  const id = req.params.id;
  mDetailOrder(id, req.shopid)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Détail de la commande récupéré.", null, response);
      } else {
        custom(res, 404, "Commande introuvable.", null, null);
      }
    })
    .catch((error) => {
      failed(res, "Erreur serveur.", error.message);
    });
};
exports.addOrder = async (req, res) => {
  const body = req.body;
  const subtotal = parseMoney(body.subtotal);
  const shopRows = await mGetShopInfo(req.shopid).catch((error) => {
    failed(res, "Erreur serveur.", error.message);
    return null;
  });
  if (!shopRows) return;

  const kitchenClosed = shopRows?.[0]?.kitchen_closed;
  if ([true, 1, "1", "true"].includes(kitchenClosed)) {
    return custom(
      res,
      422,
      "La cuisine est fermee, les nouvelles commandes sont bloquees.",
      null,
      null,
    );
  }

  if (
    !body.customer ||
    !body.customerID ||
    // !body.operator ||
    isMissing(body.subtotal) ||
    subtotal === null ||
    !body.payment ||
    !body.status
  ) {
    custom(res, 400, "Requête invalide.", null, null);
  } else {
    const timestamp = new Date().valueOf().toString();
    const randomValue = Math.floor(Math.random() * 100)
      .toString()
      .padStart(2, "0"); // génère un nombre aléatoire entre 00 et 99
    const combinedValue = timestamp + randomValue;
    const orderNumber = combinedValue.slice(-4); // prend les 4 derniers chiffres de la valeur combinée
    const data = {
      ordernumber: orderNumber,
      customer: body.customer,
      customerID: body.customerID,
      operator: body.operator,
      subtotal,
      payment: body.payment,
      remark: body.remark,
      phone: body.phone,
      status: body.status,
      created: new Date().toISOString().slice(0, 19).replace("T", " "),
      finished: new Date().toISOString().slice(0, 19).replace("T", " "),
      shopid: req.shopid,
    };
    mAddOrders(data)
      .then((response) => {
        custom(res, 201, "Commande créée avec succès.", null, response);
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  }
};
exports.deleteOrder = (req, res) => {
  const id = req.params.id;
  console.log("DELETE orders", id);
  mDeleteOrder(id)
    .then((response) => {
      console.log("REspons Delete", response);
      if (response[0].affectedRows > 0 || response[1].affectedRows > 0) {
        success(res, "Commande supprimée avec succès.", null, response);
      } else {
        custom(res, 404, "Commande introuvable.", null, null);
      }
    })
    .catch((error) => {
      console.log(error);
      failed(res, "Erreur serveur.", error.message);
    });
};
exports.addDetailOrder = (req, res) => {
  const orderid = req.body.orderid;
  const productid = req.body.productid;
  const price = parseMoney(req.body.price);
  const qty = req.body.qty;
  const total = parseMoney(req.body.total);
  const operator = req.body.operator;
  const customizationList = req.body.customizationList;

  console.log("Liste des customization", req.body?.customizationList);

  if (
    !orderid ||
    !productid ||
    price === null ||
    !qty ||
    total === null ||
    !operator
  ) {
    custom(res, 400, "Requête invalide.", null, null);
  } else {
    const dataDetail = {
      orderid,
      productid,
      price,
      qty,
      total,
    };
    mAddDetailOrder(dataDetail, customizationList)
      .then(() => {
        mReduceStock(qty, productid)
          .then(() => {
            const addStock = buildOrderDetailStockEntry({
              productid,
              qty,
              operator,
            });
            mAddNewStocks(addStock)
              .then(() => {
                success(res, "Détail de commande ajouté avec succès.", null, null);
              })
              .catch((error) => {
                failed(res, "Erreur serveur.", error.message);
              });
          })
          .catch((error) => {
            failed(res, "Erreur serveur.", error.message);
          });
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  }
};
const buildUpdateOrderController = ({
  transitionOrderStatus: transitionStatus = transitionOrderStatus,
  cancelPendingStripePayment: syncCanceledPayment = cancelPendingStripePayment,
  markPaymentCanceled: settleCanceledPayment = markPaymentCanceled,
} = {}) => async (req, res) => {
  const orderId = Number(req.params.id);
  const shopId = Number(req.shopid);
  const operator = Number(req.id);
  const nextStatus = Number(req.body.status);
  if (!operator || !nextStatus) {
    return custom(res, 400, "Requête invalide.", null, null);
  }

  let cancellationError;
  try {
    const { result } = await transitionStatus({
      orderId,
      shopId,
      operator,
      nextStatus,
      ...(nextStatus === ORDER_STATUSES.CANCELED && {
        beforeTransition: async ({ order, connection }) => {
          try {
            const paymentIntentId = await syncCanceledPayment(order);
            if (paymentIntentId) {
              await settleCanceledPayment(
                paymentIntentId,
                { connection, order },
              );
            }
          } catch (error) {
            cancellationError = error;
            throw error;
          }
        },
      }),
    });
    if (!result.affectedRows) {
      return custom(res, 404, "Commande introuvable.", null, null);
    }
    return success(res, "Commande mise à jour avec succès.", null, null);
  } catch (error) {
    if (error === cancellationError) {
      return failed(
        res,
        "Erreur lors de l'annulation du paiement Stripe.",
        error.message,
      );
    }
    if (error instanceof DomainError) {
      return custom(res, error.status, error.message, null, { code: error.code });
    }
    return failed(res, "Erreur serveur.", error.message);
  }
};

exports.buildUpdateOrderController = buildUpdateOrderController;
exports.updateOrder = buildUpdateOrderController();

const buildArchiveOrderController = ({
  findOrderById = mFindOrderById,
  syncPendingStripeBeforeCashRegisterArchive: syncPendingStripe = (
    syncPendingStripeBeforeCashRegisterArchive
  ),
  archiveOrder = mArchiveOrder,
} = {}) => async (req, res) => {
  const id = req.params.id;
  const payment_method = req.body.payment_method;
  console.log("ON archive :", id);

  try {
    const orders = await findOrderById(id, req.shopid);
    if (!orders.length) {
      return custom(res, 404, "Commande introuvable.", null, null);
    }

    await syncPendingStripe(orders[0]);

    const response = await archiveOrder(id, payment_method, req.shopid);
    if (response.affectedRows) {
      return success(res, "Commande archivée avec succès.", null, null);
    }

    return custom(res, 404, "Commande introuvable.", null, null);
  } catch (error) {
    if (error instanceof DomainError && error.code === "STRIPE_PAYMENT_NOT_SETTLED") {
      return custom(res, error.status, error.message, null, { code: error.code });
    }
    if (String(error.message || "").includes("Moyen de paiement requis")) {
      return custom(res, 422, error.message, null, null);
    }

    return failed(res, "Erreur serveur.", error.message);
  }
};

exports.buildArchiveOrderController = buildArchiveOrderController;
exports.archiveOrder = buildArchiveOrderController();

exports.allArchivedOrders = async (req, res) => {
  console.log("Controler History");
  mAllArchivedOrders(req.shopid)
    .then((response) => {
      success(res, "Commandes récupérées.", null, response);
    })
    .catch((error) => {
      failed(res, "Erreur serveur.", error.message);
    });
};

exports.detailArchivedOrder = (req, res) => {
  const id = req.params.id;
  mDetailArchivedOrder(id)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Détail de la commande récupéré.", null, response);
      } else {
        custom(res, 404, "Commande archivée introuvable.", null, null);
      }
    })

    .catch((error) => {
      failed(res, "Erreur serveur.", error.message);
    });
};
exports.orderByToken = (req, res) => {
  const token = req.params.id;
  console.log(req.params);
  mDetailArchivedOrderByToken(token).then(async (response) => {
    if (response.length > 0) {
      const shopInfo = await mGetShopInfo(response[0].shopid).then();
      console.log(shopInfo);
      const data = { orderDetail: response, shopInfo };
      success(res, "Détail de la commande récupéré.", null, data);
    } else {
      failed(res, "Ticket introuvable.", "Aucun Ticket Dispo", 404);
    }
  });
};

exports.metrics = async (req, res) => {
  console.log("Metrics Params", req.query);

  const shopId = req.shopid || req.query.shopid; // Sécurité
  let { from, to } = req.query;

  if (!from) {
    console.warn("Paramètre 'from' manquant, utilisation de la date du jour");
    from = new Date().toISOString().split("T")[0]; // date du jour
  }

  if (!to) {
    console.warn("Paramètre 'to' manquant, utilisation de la date du jour");
    to = from; // tu peux modifier selon la logique métier
  }

  console.log(`Fetching metrics for shop ${shopId} from ${from} to ${to}`);
  const allOrders = await mAllArchivedOrdersWithDetails(shopId, from, to);
  let metrics = {
    totalRevenue: Number(
      allOrders
        .reduce((total, current) => {
          return total + moneyOrZero(current.subtotal); // ou current.prix_total selon ton champ
        }, 0)
        .toFixed(2),
    ),
    totalOrders: allOrders.length,
  };

  metrics.averageOrder =
    metrics.totalOrders > 0
      ? Number((metrics.totalRevenue / metrics.totalOrders).toFixed(2))
      : 0;

  metrics.averageOrderPreparationTime =
    getAverageOrderPreparationTime(allOrders);

  metrics.paymentsSummary = getPaymentsSummary(allOrders);
  metrics.topProducts = getTopProducts(allOrders);
  // TODO: ta logique de récupération des métriques ici
  console.log("All Orderss", JSON.stringify(allOrders, null, 2));
  console.log("Metrics:", metrics);
  res.json({
    message: "Métriques récupérées avec succès",
    shopId,
    from,
    to,
    data: metrics, // mets ici les données récupérées
  });
};

function getPaymentsSummary(orders) {
  const paymentTotals = {};
  let totalPayments = 0;

  for (const order of orders) {
    const type = order.payment || "Autres";
    const montant = moneyOrZero(order.subtotal);

    if (!paymentTotals[type]) {
      paymentTotals[type] = 0;
    }

    paymentTotals[type] += montant;
    totalPayments += montant;
  }

  const result = [];

  for (const type in paymentTotals) {
    const amount = Number(paymentTotals[type].toFixed(2));
    const percentage =
      totalPayments > 0
        ? Number(((amount / totalPayments) * 100).toFixed(1))
        : 0;

    result.push({ name: type, amount, percentage });
  }

  return result;
}

function getTopProducts(allOrders) {
  const productStats = {};

  for (const order of allOrders) {
    if (!order.details || !Array.isArray(order.details)) continue;

    for (const item of order.details) {
      const name = item.name || "inconnu";
      const qty = Number(item.qty || 0);
      const revenue = moneyOrZero(item.total);

      if (!productStats[name]) {
        productStats[name] = {
          name,
          qty: 0,
          revenue: 0,
        };
      }

      productStats[name].qty += qty;
      productStats[name].revenue += revenue;
    }
  }

  // Convertir en tableau et trier par quantité ou revenu
  const topProducts = Object.values(productStats)
    .map((p) => ({
      ...p,
      revenue: Number(p.revenue.toFixed(2)),
    }))
    .sort((a, b) => b.qty - a.qty); // Tri par quantité vendue

  return topProducts;
}

function getAverageOrderPreparationTime(orders) {
  const validOrders = orders.filter(
    (o) =>
      o.created && o.finished && new Date(o.finished) > new Date(o.created),
  );

  if (validOrders.length === 0) return 0;

  const totalMinutes = validOrders.reduce((sum, order) => {
    const start = new Date(order.created);
    const end = new Date(order.finished);
    const diffMs = end - start;
    const diffMin = diffMs / 60000;
    return sum + diffMin;
  }, 0);

  return Number((totalMinutes / validOrders.length).toFixed(1));
}
