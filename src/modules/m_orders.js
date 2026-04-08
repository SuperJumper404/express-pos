const { nanoid } = require("nanoid");
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
        },
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
  mArchiveOrder: (id, payment_method) => {
    return new Promise((resolve, reject) => {
      conn.query(`SELECT * FROM orders WHERE id = ?`, [id], (err, orders) => {
        if (err) {
          reject(err);
          return;
        }

        if (!orders || orders.length === 0) {
          reject(new Error("Commande introuvable"));
          return;
        }

        const orderData = { ...orders[0] };
        delete orderData.id;

        orderData.token = nanoid();
        orderData.used_payment_method = payment_method;

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
