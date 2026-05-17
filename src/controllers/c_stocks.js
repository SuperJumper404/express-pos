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
    custom(res, 400, "Requête invalide.", {}, null);
  } else {
    mAddStock(body)
      .then(() => {
        if (body.category === "0") {
          const addQty = `stock+'${body.qty}' WHERE id='${body.productid}'`;
          updateProductStock(addQty)
            .then(() => {
              success(res, "Stock ajouté avec succès.", null, null);
            })
            .catch((error) => {
              failed(res, "Erreur serveur.", error.message);
            });
        } else if (body.category === "1") {
          const reduceQty = `stock-'${body.qty}' WHERE id='${body.productid}'`;
          updateProductStock(reduceQty)
            .then(() => {
              success(res, "Stock réduit avec succès.", null, null);
            })
            .catch((error) => {
              failed(res, "Erreur serveur.", error.message);
            });
        } else {
          const adjusmentQty = `'${body.qty}' WHERE id='${body.productid}'`;
          updateProductStock(adjusmentQty)
            .then(() => {
              success(res, "Stock ajusté avec succès.", null, null);
            })
            .catch((error) => {
              failed(res, "Erreur serveur.", error.message);
            });
        }
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  }
};
exports.allStock = async (req, res) => {
  mAllStock()
    .then((response) => {
      success(res, "Stocks récupérés.", null, response);
    })
    .catch((error) => {
      failed(res, "Erreur serveur.", error.message);
    });
};
exports.detailStocks = (req, res) => {
  const id = req.params.id;
  mDetailStock(id)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Détail du stock récupéré.", null, response);
      } else {
        custom(res, 404, "Stock introuvable.", null, []);
      }
    })
    .catch((error) => {
      failed(res, "Erreur serveur.", error.message);
    });
};
exports.detailProductStocksId = (req, res) => {
  const productId = req.params.id;
  mDetailProductStockId(productId)
    .then((response) => {
      if (response.length > 0) {
        success(res, "Stock du produit récupéré.", null, response);
      } else {
        custom(res, 404, "Produit introuvable.", null, []);
      }
    })
    .catch((error) => {
      failed(res, "Erreur serveur.", error.message);
    });
};
