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
} = require("../modules/m_orders");
const { custom, success, failed } = require("../helpers/response");
const response = require("../helpers/response");
exports.allOrder = async (req, res) => {
  mAllOrder()
    .then((response) => {
      success(res, "Get all order", response);
    })
    .catch((error) => {
      failed(res, "Internal server error!xx", error.message);
    });
};
exports.ordersbyUserId = async (req, res) => {
  const userId = req.query.userId;
  mOrdersbyUserId(userId)
    .then((response) => {
      success(res, "Get all order", response);
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
      status: body.status,
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
  mDeleteOrder(id)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Delete order", null, response);
      } else {
        custom(res, "Id not found!", null, null);
      }
    })
    .catch((error) => {
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
      remark: null,
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
              remark: "Transaction",
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
