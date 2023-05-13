const conn = require("../config/db");
module.exports = {
  mAllOrder: (shopid) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT orders.*, users.username FROM orders JOIN users ON orders.customerID = users.id WHERE orders.shopid = ? ORDER BY orders.created DESC`,
        [shopid],
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
  mOrdersbyUserId: (userId) => {
    return new Promise((resolve, reject) => {
      // const query = `SELECT * FROM orders WHERE customerID = ${userId} ORDER BY orders.created DESC`;
      const query = `SELECT orders.*, users.username FROM orders JOIN users ON orders.customerID = users.id WHERE orders.customerID =  ${userId} ORDER BY orders.created DESC`;
      conn.query(query, (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(new Error(err));
        }
      });
    });
  },
  mTotalOrders: () => {
    return new Promise((resolve, reject) => {
      conn.query(`SELECT COUNT (*) as total FROM orders`, (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(new Error(err));
        }
      });
    });
  },
  mDetailOrder: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT *, orders.id as id FROM orders LEFT JOIN orderdetail ON orders.id=orderdetail.orderId LEFT JOIN products ON orderdetail.productid=products.id WHERE orders.id='${id}' ORDER BY orders.created DESC`,
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
  mAddOrders: (data) => {
    return new Promise((resolve, reject) => {
      conn.query("INSERT INTO orders SET ? ", data, (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(new Error(err));
        }
      });
    });
  },
  mAddDetailOrder: (data) => {
    return new Promise((resolve, reject) => {
      conn.query("INSERT INTO orderdetail SET ? ", data, (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(new Error(err));
        }
      });
    });
  },
  mReduceStock: (qty, productid) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `UPDATE products SET stock=stock-'${qty}' WHERE id='${productid}'`,
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
  mAddNewStocks: (data) => {
    return new Promise((resolve, reject) => {
      conn.query("INSERT INTO stocks SET ? ", data, (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(new Error(err));
        }
      });
    });
  },
  mUpdateOrders: (data, id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "UPDATE orders SET ? WHERE id = ?",
        [data, id],
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
  mDeleteOrder: (id) => {
    return new Promise((resolve, reject) => {
      console.log("delete", id);
      conn.query(`DELETE FROM orders WHERE id = ${id}`, (err, result1) => {
        if (err) {
          reject(err);
          return;
        }
        conn.query(
          `DELETE FROM orderdetail WHERE orderid = ${id}`,
          (err, result2) => {
            if (err) {
              reject(err);
              return;
            }
            resolve([result1, result2]);
          }
        );
      });
    });
  },
  // mArchiveOrder: (id) => {
  //   return new Promise((resolve, reject) => {
  //     conn.beginTransaction((err) => {
  //       if (err) {
  //         reject(err);
  //         return;
  //       }

  //       // Récupérer les détails de la commande
  //       conn.query(`SELECT * FROM orders WHERE id = ?`, [id], (err, order) => {
  //         if (err) {
  //           conn.rollback(() => {
  //             reject(err);
  //           });
  //           return;
  //         }

  //         console.log("ORders selected", order);

  //         // Insérer la commande dans la table archives
  //         conn.query(`INSERT INTO archives SET ?`, order[0], (err, result) => {
  //           if (err) {
  //             conn.rollback(() => {
  //               console.log("Error in Archive", err);
  //               reject(err);
  //             });
  //             return;
  //           }

  //           console.log("Result", result);

  //           // Récupérer les détails de la commande
  //           conn.query(
  //             `SELECT * FROM orderdetail WHERE orderId = ?`,
  //             [id],
  //             (err, orderDetails) => {
  //               if (err) {
  //                 conn.rollback(() => {
  //                   reject(err);
  //                 });
  //                 return;
  //               }

  //               // Insérer les détails de la commande dans la table archives
  //               if (orderDetails.length > 0) {
  //                 conn.query(
  //                   `INSERT INTO archivesdetail (orderId, productid, qty, total, price) VALUES ?`,
  //                   [
  //                     orderDetails.map((detail) => [
  //                       detail.orderId,
  //                       detail.productid,
  //                       detail.qty,
  //                       detail.total,
  //                       detail.price,
  //                     ]),
  //                   ],
  //                   (err, result) => {
  //                     if (err) {
  //                       conn.rollback(() => {
  //                         reject(err);
  //                       });
  //                       return;
  //                     }
  //                   }
  //                 );
  //               }

  //               // Supprimer la commande de la table orders et orderdetail
  //               conn.query(
  //                 `DELETE FROM orders WHERE id = ?`,
  //                 [id],
  //                 (err, result) => {
  //                   if (err) {
  //                     conn.rollback(() => {
  //                       reject(err);
  //                     });
  //                     return;
  //                   }
  //                   conn.query(
  //                     `DELETE FROM orderdetail WHERE orderId = ?`,
  //                     [id],
  //                     (err, result) => {
  //                       if (err) {
  //                         conn.rollback(() => {
  //                           reject(err);
  //                         });
  //                         return;
  //                       }

  //                       // Commit la transaction
  //                       conn.commit((err) => {
  //                         if (err) {
  //                           conn.rollback(() => {
  //                             reject(err);
  //                           });
  //                         } else {
  //                           resolve(result);
  //                         }
  //                       });
  //                     }
  //                   );
  //                 }
  //               );
  //             }
  //           );
  //         });
  //       });
  //     });
  //   });
  // },
  mArchiveOrder: (id) => {
    return new Promise((resolve, reject) => {
      // Récupérer les détails de la commande
      conn.query(`SELECT * FROM orders WHERE id = ?`, [id], (err, order) => {
        if (err) {
          reject(err);
          return;
        }

        console.log("Orders selected", order);

        // Insérer la commande dans la table archives
        conn.query(`INSERT INTO archives SET ?`, order[0], (err, result) => {
          if (err) {
            console.log("Error in Archive", err);
            reject(err);
            return;
          }

          console.log("Result", result);

          // Récupérer les détails de la commande
          conn.query(
            `SELECT * FROM orderdetail WHERE orderId = ?`,
            [id],
            (err, orderDetails) => {
              if (err) {
                reject(err);
                return;
              }
              console.log("aaa", orderDetails);
              // Insérer les détails de la commande dans la table archives
              if (orderDetails.length > 0) {
                conn.query(
                  `INSERT INTO archivesdetail (orderId, productid, qty, total, price) VALUES ?`,
                  [
                    orderDetails.map((detail) => [
                      detail.orderid,
                      detail.productid,
                      detail.qty,
                      detail.total,
                      detail.price,
                    ]),
                  ],
                  (err, result) => {
                    if (err) {
                      console.log("Error in Archive Details", err);
                      reject(err);
                      return;
                    }
                  }
                );
              }

              // Supprimer la commande de la table orders et orderdetail
              conn.query(
                `DELETE FROM orders WHERE id = ?`,
                [id],
                (err, result) => {
                  if (err) {
                    reject(err);
                    return;
                  }

                  conn.query(
                    `DELETE FROM orderdetail WHERE orderId = ?`,
                    [id],
                    (err, result) => {
                      if (err) {
                        reject(err);
                        return;
                      }

                      resolve(result);
                    }
                  );
                }
              );
            }
          );
        });
      });
    });
  },
};
