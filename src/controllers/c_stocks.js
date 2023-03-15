const {
  mAddStock,
  updateProductStock,
  mAllStock,
  mDetailStock,
  mDetailProductStockId,
} = require("../modules/m_stocks");
const { custom, success, failed } = require("../helpers/response");
exports.addStock = (req, res) => {
  const body = req.body;
  if (
    !body.productid ||
    !body.category ||
    !body.qty ||
    !body.operator ||
    !body.remark
  ) {
    custom(res, 400, "Bad request", {}, null);
  } else {
    mAddStock(body)
      .then(() => {
        if (body.category === "0") {
          const addQty = `stock+'${body.qty}' WHERE id='${body.productid}'`;
          updateProductStock(addQty)
            .then(() => {
              success(res, "Success add", null, null);
            })
            .catch((error) => {
              failed(res, "Internal server error!", error.message);
            });
        } else if (body.category === "1") {
          const reduceQty = `stock-'${body.qty}' WHERE id='${body.productid}'`;
          updateProductStock(reduceQty)
            .then(() => {
              success(res, "Success reduce", null, null);
            })
            .catch((error) => {
              failed(res, "Internal server error!", error.message);
            });
        } else {
          const adjusmentQty = `'${body.qty}' WHERE id='${body.productid}'`;
          updateProductStock(adjusmentQty)
            .then(() => {
              success(res, "Success adjusment", null, null);
            })
            .catch((error) => {
              failed(res, "Internal server error!", error.message);
            });
        }
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
      });
  }
};
exports.allStock = async (req, res) => {
  mAllStock()
    .then((response) => {
      success(res, "Get all stock", null, response);
    })
    .catch((error) => {
      failed(res, "Internal server error!", error.message);
    });
};
exports.detailStocks = (req, res) => {
  const id = req.params.id;
  mDetailStock(id)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Detail stock!", null, response);
      } else {
        custom(res, 404, "Id stock not found!", null, []);
      }
    })
    .catch((error) => {
      failed(res, "Internal server error!", error.message);
    });
};
exports.detailProductStocksId = (req, res) => {
  const productId = req.params.id;
  mDetailProductStockId(productId)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Detail stock product id!", null, response);
      } else {
        custom(res, 404, "Product id not found!", null, []);
      }
    })
    .catch((error) => {
      failed(res, "Internal server error!", error.message);
    });
};
