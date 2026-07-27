const { nanoid } = require("nanoid");
const conn = require("../config/db");
const pool = require("../config/dbPool");
const {
  buildCashRegisterArchiveFields,
} = require("../helpers/cashRegisterPayment");
const { parseMoney } = require("../helpers/money");
const { withTransaction } = require("../helpers/withTransaction");

const queryResult = async (connection, sql, params = []) => {
  const [result] = await (connection || pool).query(sql, params);
  return result;
};

const archiveSqlRepository = {
  findOrderForArchive: ({ orderId, shopId, connection }) => {
    const shopClause = shopId == null ? "" : " AND shopid = ?";
    const params = shopId == null ? [orderId] : [orderId, shopId];
    return queryResult(
      connection,
      `SELECT * FROM orders
       WHERE id = ?${shopClause}
       LIMIT 1 FOR UPDATE`,
      params,
    ).then((rows) => rows[0] || null);
  },
  insertArchive: ({ archive, connection }) => queryResult(
    connection,
    "INSERT INTO archives SET ?",
    [archive],
  ),
  findOrderDetails: ({ orderId, connection }) => queryResult(
    connection,
    "SELECT * FROM orderdetail WHERE orderid = ? ORDER BY id FOR UPDATE",
    [orderId],
  ),
  findActiveSnapshots: ({ detailIds, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT * FROM orderdetail_customization_snapshots
       WHERE orderdetail_id IN (?)
       ORDER BY orderdetail_id, step_position, choice_position, id`,
      [detailIds],
    )
  ),
  insertArchiveDetail: ({ detail, connection }) => queryResult(
    connection,
    "INSERT INTO archivesdetail SET ?",
    [detail],
  ),
  insertArchiveSnapshot: ({ snapshot, connection }) => queryResult(
    connection,
    "INSERT INTO archivesdetail_customization_snapshots SET ?",
    [snapshot],
  ),
  deleteActiveSnapshots: ({ detailIds, connection }) => (
    detailIds.length === 0 ? Promise.resolve({ affectedRows: 0 }) : queryResult(
      connection,
      "DELETE FROM orderdetail_customization_snapshots WHERE orderdetail_id IN (?)",
      [detailIds],
    )
  ),
  deleteLegacyCustomizations: ({ orderId, connection }) => queryResult(
    connection,
    "DELETE FROM orders_customization WHERE order_id = ?",
    [orderId],
  ),
  deleteOrderDetails: ({ orderId, connection }) => queryResult(
    connection,
    "DELETE FROM orderdetail WHERE orderid = ?",
    [orderId],
  ),
  deleteOrder: ({ orderId, connection }) => queryResult(
    connection,
    "DELETE FROM orders WHERE id = ?",
    [orderId],
  ),
  findActiveOrderDetails: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT *, orders.id AS id, orderdetail.id AS orderDetailsId
     FROM orders
     LEFT JOIN orderdetail ON orders.id = orderdetail.orderid
     LEFT JOIN products ON orderdetail.productid = products.id
     WHERE orders.id = ? AND orders.shopid = ?
     ORDER BY orders.created DESC`,
    [orderId, shopId],
  ),
  findLegacyCustomizations: ({ orderId, detailIds, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT orders_customization.order_id,
              orders_customization.order_details_id,
              orders_customization.product_id,
              orders_customization.product_choice_id,
              product_choice.name,
              product_choice.price
       FROM orders_customization
       LEFT JOIN product_choice
         ON product_choice.id = orders_customization.product_choice_id
       WHERE orders_customization.order_id = ?
         AND orders_customization.order_details_id IN (?)
       ORDER BY orders_customization.order_details_id, orders_customization.id`,
      [orderId, detailIds],
    )
  ),
  findArchivedOrderDetailsById: ({ archiveId, connection }) => queryResult(
    connection,
    `SELECT *, archives.id AS id, archivesdetail.id AS archiveDetailsId
     FROM archives
     LEFT JOIN archivesdetail ON archives.id = archivesdetail.orderId
     LEFT JOIN products ON archivesdetail.productid = products.id
     WHERE archives.id = ?
     ORDER BY archives.created DESC`,
    [archiveId],
  ),
  findArchivedOrderDetailsByToken: ({ token, connection }) => queryResult(
    connection,
    `SELECT *, archives.id AS id, archivesdetail.id AS archiveDetailsId
     FROM archives
     LEFT JOIN archivesdetail ON archives.id = archivesdetail.orderId
     LEFT JOIN products ON archivesdetail.productid = products.id
     WHERE archives.token = ?`,
    [token],
  ),
  findArchiveSnapshots: ({ detailIds, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT * FROM archivesdetail_customization_snapshots
       WHERE archivesdetail_id IN (?)
       ORDER BY archivesdetail_id, step_position, choice_position, id`,
      [detailIds],
    )
  ),
};

const groupBy = (rows, key) => rows.reduce((groups, row) => {
  const value = row[key];
  if (!groups.has(value)) groups.set(value, []);
  groups.get(value).push(row);
  return groups;
}, new Map());

const ARCHIVE_ORDER_FIELDS = [
  "shopid",
  "ordernumber",
  "customer",
  "phone",
  "customerID",
  "operator",
  "subtotal",
  "payment",
  "status",
  "created",
  "finished",
  "remark",
  "is_takeaway",
];

const pickArchiveOrderFields = (order = {}) => ARCHIVE_ORDER_FIELDS.reduce(
  (archive, field) => {
    if (Object.prototype.hasOwnProperty.call(order, field)) {
      archive[field] = order[field];
    }
    return archive;
  },
  {},
);

const mapSnapshotCustomization = (row) => ({
  product_customization_step_id: row.product_customization_step_id,
  step_name: row.step_name,
  step_position: row.step_position,
  name: row.choice_name,
  choice_position: row.choice_position,
  price: parseMoney(row.unit_extra_price),
  product_choice_id: null,
});

const mapLegacyCustomization = (row) => ({
  name: row.name,
  product_choice_id: row.product_choice_id,
  price: parseMoney(row.price),
});

const buildOrderArchiveModule = ({
  repository = archiveSqlRepository,
  withTransaction: runInTransaction = withTransaction,
  createToken = nanoid,
} = {}) => {
  const hydrateActiveDetails = async (rows, orderId, connection) => {
    const detailIds = rows.map((row) => row.orderDetailsId).filter(Boolean);
    const snapshots = await repository.findActiveSnapshots({ detailIds, connection });
    const snapshotsByDetail = groupBy(snapshots, "orderdetail_id");
    const legacyDetailIds = detailIds.filter((detailId) => !snapshotsByDetail.has(detailId));
    const legacyRows = await repository.findLegacyCustomizations({
      orderId,
      detailIds: legacyDetailIds,
      connection,
    });
    const legacyByDetail = groupBy(legacyRows, "order_details_id");

    return rows.map((row) => {
      const result = { ...row };
      if (snapshotsByDetail.has(row.orderDetailsId)) {
        result.customizationList = snapshotsByDetail
          .get(row.orderDetailsId)
          .map(mapSnapshotCustomization);
      } else if (legacyByDetail.has(row.orderDetailsId)) {
        result.customizationList = legacyByDetail
          .get(row.orderDetailsId)
          .map(mapLegacyCustomization);
      }
      return result;
    });
  };

  const hydrateArchivedDetails = async (rows, connection) => {
    const detailIds = rows.map((row) => row.archiveDetailsId).filter(Boolean);
    const snapshots = await repository.findArchiveSnapshots({ detailIds, connection });
    const snapshotsByDetail = groupBy(snapshots, "archivesdetail_id");
    return rows.map((row) => {
      const result = { ...row };
      if (snapshotsByDetail.has(row.archiveDetailsId)) {
        result.customizationList = snapshotsByDetail
          .get(row.archiveDetailsId)
          .map(mapSnapshotCustomization);
      }
      return result;
    });
  };

  const mArchiveOrder = (id, paymentMethod, shopId) => runInTransaction(
    async (connection) => {
      const order = await repository.findOrderForArchive({
        orderId: id,
        shopId,
        connection,
      });
      if (!order) throw new Error("Commande introuvable");

      const archivePaymentFields = buildCashRegisterArchiveFields({
        order,
        paymentMethod,
      });
      const archive = {
        ...pickArchiveOrderFields(order),
        ...archivePaymentFields,
        token: createToken(),
      };
      const archiveResult = await repository.insertArchive({ archive, connection });
      const archiveOrderId = archiveResult.insertId;

      const orderDetails = await repository.findOrderDetails({
        orderId: id,
        connection,
      });
      const detailIds = orderDetails.map((detail) => detail.id);
      const activeSnapshots = await repository.findActiveSnapshots({
        detailIds,
        connection,
      });
      const snapshotsByDetail = groupBy(activeSnapshots, "orderdetail_id");

      for (const detail of orderDetails) {
        const archiveDetailResult = await repository.insertArchiveDetail({
          detail: {
            orderId: archiveOrderId,
            productid: detail.productid,
            qty: detail.qty,
            total: detail.total,
            price: detail.price,
            vat_rate: detail.vat_rate,
            unit_price_ht: detail.unit_price_ht,
            unit_vat: detail.unit_vat,
            total_ht: detail.total_ht,
            total_vat: detail.total_vat,
          },
          connection,
        });
        for (const snapshot of snapshotsByDetail.get(detail.id) || []) {
          await repository.insertArchiveSnapshot({
            snapshot: {
              archivesdetail_id: archiveDetailResult.insertId,
              product_customization_step_id: snapshot.product_customization_step_id,
              product_customization_step_choice_id:
                snapshot.product_customization_step_choice_id,
              step_name: snapshot.step_name,
              step_position: snapshot.step_position,
              choice_type: snapshot.choice_type,
              choice_name: snapshot.choice_name,
              choice_position: snapshot.choice_position,
              unit_extra_price: snapshot.unit_extra_price,
              linked_product_id: snapshot.linked_product_id,
              created: snapshot.created,
            },
            connection,
          });
        }
      }

      await repository.deleteActiveSnapshots({ detailIds, connection });
      await repository.deleteLegacyCustomizations({ orderId: id, connection });
      await repository.deleteOrderDetails({ orderId: id, connection });
      return repository.deleteOrder({ orderId: id, connection });
    },
  );

  const mDetailOrder = async (id, shopId) => {
    const rows = await repository.findActiveOrderDetails({ orderId: id, shopId });
    return hydrateActiveDetails(rows, Number(id));
  };

  const mDetailArchivedOrder = async (id) => {
    const rows = await repository.findArchivedOrderDetailsById({ archiveId: id });
    return hydrateArchivedDetails(rows);
  };

  const mDetailArchivedOrderByToken = async (token) => {
    const rows = await repository.findArchivedOrderDetailsByToken({ token });
    return hydrateArchivedDetails(rows);
  };

  return {
    hydrateArchivedDetails,
    mArchiveOrder,
    mDetailArchivedOrder,
    mDetailArchivedOrderByToken,
    mDetailOrder,
  };
};

const orderArchiveModule = buildOrderArchiveModule();

module.exports = {
  mAllOrder: (shopid) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT orders.*, users.username FROM orders JOIN users ON orders.customerID = users.id WHERE orders.shopid = ? AND orders.status <> 0 ORDER BY orders.created DESC`,
        [shopid],
        (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(new Error(err));
          }
        },
      );
    });
  },
  mFindOrderById: (id, shopid) => {
    return new Promise((resolve, reject) => {
      const query = shopid
        ? "SELECT * FROM orders WHERE id = ? AND shopid = ? LIMIT 1"
        : "SELECT * FROM orders WHERE id = ? LIMIT 1";
      const params = shopid ? [id, shopid] : [id];

      conn.query(query, params, (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(new Error(err));
        }
      });
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
  // LEFT JOIN orders_customization ON orders_customization.order_id=orders.id AND orders_customization.product_id=orderdetail.productid LEFT JOIN orders_customization.product_choic
  // `SELECT *, orders.id as id FROM orders LEFT JOIN orderdetail ON orders.id=orderdetail.orderId LEFT JOIN products ON orderdetail.productid=products.id LEFT JOIN orders_customization ON orders_customization.order_id=orders.id AND orders_customization.product_id=orderdetail.productid LEFT JOIN orders_customization.product_choic WHERE orders.id='${id}' ORDER BY orders.created DESC`,
  mDetailOrder: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT *, orders.id as id, orderdetail.id as orderDetailsId FROM orders LEFT JOIN orderdetail ON orders.id=orderdetail.orderId LEFT JOIN products ON orderdetail.productid=products.id WHERE orders.id='${id}' ORDER BY orders.created DESC`,
        (err, result) => {
          if (!err) {
            const customizationPromises = [];

            result.forEach((row) => {
              console.log("ROW FIRST", row);
              const customizationPromise = new Promise(
                (subresolve, subreject) => {
                  conn.query(
                    `SELECT * FROM orders_customization  LEFT JOIN product_choice ON product_choice.id=orders_customization.product_choice_id WHERE order_id='${row.id}' AND product_id='${row.productid}' AND order_details_id='${row.orderDetailsId}' `,
                    (err, result) => {
                      console.log(
                        "CUSTOMIZATION RESULT",
                        JSON.stringify(result, null, 2),
                      );
                      if (!err) {
                        const mappedResult = {};
                        result.forEach((item) => {
                          console.log("ITEM", item);
                          if (!mappedResult.order_id) {
                            mappedResult.order_id = item.order_id;
                            mappedResult.product_id = item.product_id;
                            mappedResult.price = item.price;
                            mappedResult.order_details_id =
                              item.order_details_id;
                            mappedResult.customizationList = [];
                          }

                          // Ajoutez chaque personnalisation à la liste customList
                          mappedResult.customizationList.push({
                            name: item.name,
                            product_choice_id: item.product_choice_id,
                            price: item.price,
                          });
                        });
                        console.log("SUB ROW", mappedResult);
                        subresolve(mappedResult);
                      } else {
                        subreject(new Error(err));
                      }
                    },
                  );
                },
              );
              customizationPromises.push(customizationPromise);
            });
            Promise.all(customizationPromises)
              .then((customizationResults) => {
                // Maintenant, nous parcourons le tableau de résultat principal
                // et ajoutons les données de personnalisation correspondantes
                console.log(
                  "Customization Results",
                  JSON.stringify(customizationResults, null, 2),
                );
                const mergedResults = result.map((mainRow) => {
                  console.log("MAIN ROW", mainRow);
                  const customizationResult = customizationResults.find(
                    (customRow) => {
                      return (
                        customRow.order_id === mainRow.id &&
                        customRow.product_id === mainRow.productid &&
                        customRow.order_details_id === mainRow.orderDetailsId
                      );
                    },
                  );
                  console.log("FOUND CUSTOMIZATION", customizationResult);
                  if (customizationResult) {
                    mainRow.customizationList =
                      customizationResult.customizationList;
                  }
                  console.log("MERGED ROW", mainRow);
                  return mainRow;
                });

                console.log(
                  "Merged Results",
                  JSON.stringify(mergedResults, null, 2),
                );
                resolve(mergedResults);
              })
              .catch((err) => {
                reject(err);
              });
          } else {
            reject(new Error(err));
          }
        },
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
  mAddDetailOrder: (data, customizationList) => {
    return new Promise((resolve, reject) => {
      conn.query("INSERT INTO orderdetail SET ? ", data, (err, result) => {
        console.log("ADD DETAIL ORDER", err, result);
        if (!err) {
          let insertPromises = [];
          console.log("FLAG", customizationList);
          if (customizationList) {
            customizationList.forEach((element) => {
              const orderCustomizationData = {
                order_id: data.orderid,
                order_details_id: result.insertId,
                product_id: data.productid,
                product_choice_id: element.id,
              };

              const promise = new Promise((innerResolve, innerReject) => {
                conn.query(
                  "INSERT INTO orders_customization SET ?",
                  orderCustomizationData,
                  (err, result) => {
                    if (!err) {
                      innerResolve(result);
                    } else {
                      innerReject(new Error(err));
                    }
                  },
                );
              });
              insertPromises.push(promise);
            });
          }
          Promise.all(insertPromises)
            .then((results) => {
              resolve(results);
            })
            .catch((err) => {
              reject(err);
            });
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
        },
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
        },
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
          },
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
  mArchiveOrder: (id, payment_method, shopid) => {
    return new Promise((resolve, reject) => {
      const orderQuery = shopid
        ? "SELECT * FROM orders WHERE id = ? AND shopid = ? LIMIT 1"
        : "SELECT * FROM orders WHERE id = ? LIMIT 1";
      const orderParams = shopid ? [id, shopid] : [id];

      conn.query(orderQuery, orderParams, (err, orders) => {
        if (err) {
          reject(err);
          return;
        }

        if (!orders || orders.length === 0) {
          reject(new Error("Commande introuvable"));
          return;
        }

        const archivePaymentFields = buildCashRegisterArchiveFields({
          order: orders[0],
          paymentMethod: payment_method,
        });
        const orderData = { ...orders[0], ...archivePaymentFields };
        delete orderData.id;

        orderData.token = nanoid();

        conn.query(`INSERT INTO archives SET ?`, orderData, (err, result) => {
          if (err) {
            console.log("Error in Archive", err);
            reject(err);
            return;
          }

          console.log("Result archive", result);

          // id généré dans la table archives
          const archiveOrderId = result.insertId;

          conn.query(
            `SELECT * FROM orderdetail WHERE orderId = ?`,
            [id],
            (err, orderDetails) => {
              if (err) {
                reject(err);
                return;
              }

              console.log("orderDetails", orderDetails);

              const deleteOriginalData = () => {
                conn.query(
                  `DELETE FROM orderdetail WHERE orderId = ?`,
                  [id],
                  (err) => {
                    if (err) {
                      reject(err);
                      return;
                    }

                    conn.query(
                      `DELETE FROM orders WHERE id = ?`,
                      [id],
                      (err, result) => {
                        if (err) {
                          reject(err);
                          return;
                        }

                        resolve(result);
                      },
                    );
                  },
                );
              };

              if (orderDetails.length > 0) {
                conn.query(
                  `INSERT INTO archivesdetail (orderId, productid, qty, total, price) VALUES ?`,
                  [
                    orderDetails.map((detail) => [
                      archiveOrderId, // <- ici on met l'id de archives
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

                    console.log("orders detail archive", result);

                    deleteOriginalData();
                  },
                );
              } else {
                deleteOriginalData();
              }
            },
          );
        });
      });
    });
  },
  mAllArchivedOrders: (shopid) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT archives.*, users.username FROM archives JOIN users ON archives.customerID = users.id WHERE archives.shopid = ? ORDER BY archives.created DESC`,
        [shopid],
        (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(new Error(err));
          }
        },
      );
    });
  },
  mDetailArchivedOrder: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT *, archives.id as id FROM archives LEFT JOIN archivesdetail ON archives.id=archivesdetail.orderId LEFT JOIN products ON archivesdetail.productid=products.id WHERE archives.id='${id}' ORDER BY archives.created DESC`,
        (err, result) => {
          if (!err) {
            //   const customizationPromises = [];

            // result.forEach((row) => {
            //   const customizationPromise = new Promise(
            //     (subresolve, subreject) => {
            //       conn.query(
            //         `SELECT * FROM orders_customization  LEFT JOIN product_choice ON product_choice.id=orders_customization.product_choice_id WHERE order_id='${row.id}' AND product_id='${row.productid}' `,
            //         (err, result) => {
            //           if (!err) {
            //             const mappedResult = {};
            //             result.forEach((item) => {
            //               // Si l'objet result n'a pas encore été initialisé pour cette commande, faites-le maintenant
            //               if (!mappedResult.order_id) {
            //                 mappedResult.order_id = item.order_id;
            //                 mappedResult.product_id = item.product_id;
            //                 mappedResult.price = item.price;
            //                 mappedResult.customizationList = [];
            //               }

            //               // Ajoutez chaque personnalisation à la liste customList
            //               mappedResult.customizationList.push({
            //                 name: item.name,
            //                 product_choice_id: item.product_choice_id,
            //                 price: item.price,
            //               });
            //             });
            //             console.log("SUB ROW", mappedResult);
            //             subresolve(mappedResult);
            //           } else {
            //             subreject(new Error(err));
            //           }
            //         }
            //       );
            //     }
            //   );
            //   customizationPromises.push(customizationPromise);
            // });
            console.log("DEtail Order", result);
            resolve(result);
            // Promise.all(customizationPromises)
            //   .then((customizationResults) => {
            //     // Maintenant, nous parcourons le tableau de résultat principal
            //     // et ajoutons les données de personnalisation correspondantes
            //     const mergedResults = result.map((mainRow) => {
            //       const customizationResult = customizationResults.find(
            //         (customRow) => {
            //           return (
            //             customRow.order_id === mainRow.id &&
            //             customRow.product_id === mainRow.productid
            //           );
            //         }
            //       );

            //       if (customizationResult) {
            //         mainRow.customizationList =
            //           customizationResult.customizationList;
            //       }

            //       return mainRow;
            //     });

            //     console.log("Merged Results", mergedResults);
            //     resolve(mergedResults);
            //   })
            //   .catch((err) => {
            //     reject(err);
            //   });
          } else {
            reject(new Error(err));
          }
        },
      );
    });
  },
  mDetailArchivedOrderByToken: (token) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT *, archives.id as id FROM archives LEFT JOIN archivesdetail ON archives.id=archivesdetail.orderId LEFT JOIN products ON archivesdetail.productid=products.id WHERE archives.token='${token}'`,
        (err, result) => {
          if (!err) {
            console.log("DEtail Order", result);
            resolve(result);
          } else {
            reject(new Error(err));
          }
        },
      );
    });
  },

  mAllArchivedOrdersWithDetails: (shopId, from, to) => {
    return new Promise((resolve, reject) => {
      // Étape 1 : Récupérer les commandes archivées dans la plage de dates
      const query1 = `
      SELECT archives.*, users.username 
      FROM archives 
      JOIN users ON archives.customerID = users.id 
      WHERE archives.shopid = ? 
        AND DATE(archives.created) BETWEEN ? AND ? 
      ORDER BY archives.created DESC`;

      conn.query(query1, [shopId, from, to], (err, orders) => {
        if (err) return reject(err);
        if (!orders.length) return resolve([]);

        const orderIds = orders.map((order) => order.id);

        // Étape 2 : Récupérer les détails pour ces commandes
        const query2 = `
        SELECT 
            archivesdetail.*, 
            products.*, 
            archivesdetail.id AS archiveDetailsId,
            archivesdetail.orderId, 
            archivesdetail.qty, 
            archivesdetail.price AS detailPrice, 
            products.price AS productPrice 
        FROM archivesdetail 
        LEFT JOIN products ON archivesdetail.productid = products.id 
        WHERE archivesdetail.orderId IN (?)`;

        conn.query(query2, [orderIds], (err, details) => {
          if (err) return reject(err);

          // Étape 3 : Organiser les détails par commande
          const detailsMap = {};
          for (const detail of details) {
            if (!detailsMap[detail.orderId]) {
              detailsMap[detail.orderId] = [];
            }
            detailsMap[detail.orderId].push(detail);
          }

          // Étape 4 : Associer les détails aux commandes
          const enrichedOrders = orders.map((order) => ({
            ...order,
            details: detailsMap[order.id] || [],
          }));

          resolve(enrichedOrders);
        });
      });
    });
  },
};

const legacyAllArchivedOrdersWithDetails = module.exports.mAllArchivedOrdersWithDetails;
module.exports.buildOrderArchiveModule = buildOrderArchiveModule;
module.exports.mArchiveOrder = orderArchiveModule.mArchiveOrder;
module.exports.mDetailArchivedOrder = orderArchiveModule.mDetailArchivedOrder;
module.exports.mDetailArchivedOrderByToken = orderArchiveModule.mDetailArchivedOrderByToken;
module.exports.mDetailOrder = orderArchiveModule.mDetailOrder;
module.exports.mAllArchivedOrdersWithDetails = async (...args) => {
  const orders = await legacyAllArchivedOrdersWithDetails(...args);
  return Promise.all(orders.map(async (order) => ({
    ...order,
    details: await orderArchiveModule.hydrateArchivedDetails(order.details || []),
  })));
};
