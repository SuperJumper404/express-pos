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
} = require("../modules/m_orders");

const { custom, success, failed } = require("../helpers/response");
const response = require("../helpers/response");
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
  if (
    !body.customer ||
    !body.customerID ||
    // !body.operator ||
    !body.subtotal ||
    !body.payment ||
    !body.status
  ) {
    custom(res, 400, "Bad request!", null, null);
  } else {
    const data = {
      ordernumber: `${new Date().valueOf()}`,
      customer: body.customer,
      customerID: body.customerID,
      operator: body.operator,
      subtotal: body.subtotal,
      payment: body.payment,
      remark: body.remark,
      phone: body.phone,
      status: body.status,
      created: body.created,
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
  const price = req.body.price;
  const qty = req.body.qty;
  const total = req.body.total;
  const operator = req.body.operator;

  if (!orderid || !productid || !price || !qty || !total || !operator) {
    custom(res, 400, "Bad request!", null, null);
  } else {
    const dataDetail = {
      orderid,
      productid,
      price,
      qty,
      total,
    };
    mAddDetailOrder(dataDetail)
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
  const body = req.body;
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
  console.log("On passe ici", id);

  mArchiveOrder(id)
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
