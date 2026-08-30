const { withTransaction } = require("../helpers/withTransaction");

let conn;
const getLegacyConnection = () => {
  if (!conn) conn = require("../config/db");
  return conn;
};

const query = async (connection, sql, params = []) => {
  const [result] = await connection.query(sql, params);
  return result;
};

const buildStockModule = ({
  legacyConnection = null,
  runInTransaction = withTransaction,
} = {}) => {
  const connection = () => legacyConnection || getLegacyConnection();
  return {
    mAddStock: (data) => {
      return new Promise((resolve, reject) => {
        connection().query("INSERT INTO stocks SET ?", data, (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(new Error(err));
          }
        });
      });
    },
    updateProductStock: ({ productId, category, quantity }) =>
      runInTransaction(async (transactionConnection) => {
        const numericQuantity = Number(quantity);
        const expressions = {
          "0": "stock + ?",
          "1": "stock - ?",
        };
        const expression = expressions[category] || "?";
        const result = await query(
          transactionConnection,
          `UPDATE products SET stock = ${expression} WHERE id = ?`,
          [numericQuantity, productId]
        );

        await query(
          transactionConnection,
          `UPDATE stock_items si
         JOIN products p ON p.stock_item_id = si.id
         SET si.current_stock = p.stock
         WHERE p.id = ?`,
          [productId]
        );
        return result;
      }),
    mAllStock: () => {
      return new Promise((resolve, reject) => {
        connection().query(
          `
      SELECT stocks.id AS id, stocks.productid AS productid, stocks.category AS category, stocks.qty AS qty, stocks.operator AS operator, stocks.remark AS remark, stocks.created AS created, stocks.updated AS updated, users.username AS username, CONCAT_WS(' ', users.firstname, users.lastname) AS name
      FROM stocks LEFT JOIN products ON stocks.productId=products.id LEFT JOIN users ON stocks.operator=users.id`,
          (err, result) => {
            if (!err) {
              resolve(result);
            } else {
              reject(new Error(err));
            }
          }
        );
      });
    },
    mTotalStock: () => {
      return new Promise((resolve, reject) => {
        connection().query(
          `
      SELECT stocks.id AS id, stocks.productid AS productid, stocks.category AS category, stocks.qty AS qty, stocks.operator AS operator, stocks.remark AS remark, stocks.created AS created, stocks.updated AS updated, users.username AS username, CONCAT_WS(' ', users.firstname, users.lastname) AS name,
      COUNT (*) AS total FROM stocks LEFT JOIN products ON stocks.productId=products.id LEFT JOIN users ON stocks.operator=users.id`,
          (error, result) => {
            if (!error) {
              resolve(result);
            } else {
              reject(new Error(error));
            }
          }
        );
      });
    },
    mDetailStock: (id) => {
      return new Promise((resolve, reject) => {
        connection().query(
          `
      SELECT stocks.id AS id, stocks.productid AS productid, stocks.category AS category, stocks.qty AS qty, stocks.operator AS operator, stocks.remark AS remark, stocks.created AS created, stocks.updated AS updated, users.username AS username, CONCAT_WS(' ', users.firstname, users.lastname) AS name
      FROM stocks LEFT JOIN products ON stocks.productId=products.id LEFT JOIN users ON stocks.operator=users.id
      WHERE stocks.id='${id}'`,
          (err, result) => {
            if (!err) {
              resolve(result);
            } else {
              reject(new Error(err));
            }
          }
        );
      });
    },
    mDetailProductStockId: (id) => {
      return new Promise((resolve, reject) => {
        connection().query(
          `
      SELECT stocks.id AS id, stocks.productid AS productid, stocks.category AS category, stocks.qty AS qty, stocks.operator AS operator, stocks.remark AS remark, stocks.created AS created, stocks.updated AS updated, users.username AS username, CONCAT_WS(' ', users.firstname, users.lastname) AS name
      FROM stocks LEFT JOIN products ON stocks.productId=products.id LEFT JOIN users ON stocks.operator=users.id
      WHERE stocks.productid='${id}'`,
          (err, result) => {
            if (!err) {
              resolve(result);
            } else {
              reject(new Error(err));
            }
          }
        );
      });
    },
  };
};

module.exports = {
  ...buildStockModule(),
  buildStockModule,
};
