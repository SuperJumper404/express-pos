const {
  mAllOrder,
  mDetailOrder,
  mAddOrders,
  mAddDetailOrder,
  mReduceStock,
  mAddNewStocks,
  mUpdateOrders,
  mDeleteOrder,
  mOrdersbyUserId,
  mArchiveOrder,
  mAllArchivedOrders,
  mDetailArchivedOrder,
  mDetailArchivedOrderByToken,
  mAllArchivedOrdersWithDetails,
} = require("../modules/m_orders");

const { custom, success, failed } = require("../helpers/response");
const { envJWTKEY } = require("../helpers/env");
const { isMissing, parseMoney } = require("../helpers/money");

const jwt = require("jsonwebtoken");
const response = require("../helpers/response");
const { mGetShopInfo } = require("../modules/m_shop");
exports.allOrder = async (req, res) => {
  mAllOrder(req.shopid)
    .then((response) => {
      success(res, "Get all order", null, response);
    })
    .catch((error) => {
      failed(res, "Internal server error!xx", error.message);
    });
};
exports.ordersbyUserId = async (req, res) => {
  const userId = req.query.userId;
  mOrdersbyUserId(userId)
    .then((response) => {
      success(res, "Get all order", null, response);
    })
    .catch((error) => {
      failed(res, "Internal server error!xx", error.message);
    });
};
exports.detailOrder = (req, res) => {
  const id = req.params.id;
  mDetailOrder(id)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Detail order", null, response);
      } else {
        custom(res, "Id not found!", null, null);
      }
    })
    .catch((error) => {
      failed(res, "Internal server error!", error.message);
    });
};
exports.addOrder = (req, res) => {
  const body = req.body;
  const subtotal = parseMoney(body.subtotal);
  if (
    !body.customer ||
    !body.customerID ||
    // !body.operator ||
    isMissing(body.subtotal) ||
    subtotal === null ||
    !body.payment ||
    !body.status
  ) {
    custom(res, 400, "Bad request!", null, null);
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
        custom(res, 201, "Add orders success!", null, response);
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
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
        success(res, "Delete order", null, response);
      } else {
        custom(res, "Id not found!", null, null);
      }
    })
    .catch((error) => {
      console.log(error);
      failed(res, "Internal server error!", error.message);
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
    custom(res, 400, "Bad request!", null, null);
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
            const addStock = {
              productid,
              category: "1",
              qty,
              operator,
            };
            mAddNewStocks(addStock)
              .then(() => {
                success(res, "Success Add Detail", null, null);
              })
              .catch((error) => {
                failed(res, "Internal server error!", error.message);
              });
          })
          .catch((error) => {
            failed(res, "Internal server error!", error.message);
          });
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
      });
  }
};
exports.updateOrder = async (req, res) => {
  const id = req.params.id;
  let body = req.body;
  body.finished = new Date().toISOString().slice(0, 19).replace("T", " ");
  if (!req.body.operator || !req.body.status) {
    custom(res, 400, "Bad request!", null, null);
  } else {
    let currentStatus = await mDetailOrder(id).then((response) => {
      return response;
    });
    if (
      (currentStatus[0].status == 1 && body.status == 2) ||
      (currentStatus[0].status == 2 && body.status == 3) ||
      (currentStatus[0].status == 1 && body.status == 4) ||
      (currentStatus[0].status == 2 && body.status == 4)
    ) {
      mUpdateOrders(body, id)
        .then((response) => {
          if (response.affectedRows) {
            success(res, "Update orders success!", null, null);
          } else {
            custom(res, 404, "Id orders not found!", null, null);
          }
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    }
  }
};

exports.archiveOrder = (req, res) => {
  const id = req.params.id;
  const payment_method = req.body.payment_method;
  console.log("ON archive :", id);

  mArchiveOrder(id, payment_method)
    .then((response) => {
      if (response.affectedRows) {
        success(res, "Archive order success!", null, null);
      } else {
        custom(res, 404, "Id order not found!", null, null);
      }
    })
    .catch((error) => {
      failed(res, "Internal server error!", error.message);
    });
};

exports.allArchivedOrders = async (req, res) => {
  console.log("Controler History");
  mAllArchivedOrders(req.shopid)
    .then((response) => {
      success(res, "Get all order", null, response);
    })
    .catch((error) => {
      failed(res, "Internal server error!xx", error.message);
    });
};

exports.detailArchivedOrder = (req, res) => {
  const id = req.params.id;
  mDetailArchivedOrder(id)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Detail order", null, response);
      } else {
        custom(res, "Id not found!", null, null);
      }
    })

    .catch((error) => {
      failed(res, "Internal server error!", error.message);
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
      success(res, "Detail order", null, data);
    } else {
      failed(res, "Id not found!", "Aucun Ticket Dispo");
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
    totalRevenue: allOrders.reduce((total, current) => {
      return total + (current.subtotal || 0); // ou current.prix_total selon ton champ
    }, 0),
    totalOrders: allOrders.length,
  };

  metrics.averageOrder = Number(
    metrics.totalRevenue / metrics.totalOrders,
  ).toFixed(2);

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
    const montant = order.subtotal || 0;

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
      const qty = item.qty || 0;
      const revenue = item.total || 0;

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
