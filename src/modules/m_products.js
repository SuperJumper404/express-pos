const conn = require("../config/db");

const mDetailProduct = function (id) {
  return new Promise((resolve, reject) => {
    // 1. Récupérez toutes les informations du produit, ses personnalisations et ses choix.
    conn.query(
      `SELECT 
      products.*, 
  category.name AS category ,
  product_customization.id AS customization_id,
  product_customization.name AS customization_name,
  product_customization.description AS customization_description,
  product_customization.limit_choice AS customization_limit,
  product_customization.mandatory AS customization_mandatory,
  product_choice.id AS choice_id,
  product_choice.name AS choice_name,
  product_choice.price AS choice_price 
FROM products 
LEFT JOIN category ON products.categoryId=category.id 
LEFT JOIN product_customization ON products.id=product_customization.product_id 
LEFT JOIN product_choice ON product_customization.id=product_choice.product_customization_id 
WHERE products.id = ?
`,
      [id],
      (err, result) => {
        if (err) {
          console.log("Error DEtail Product", err);
          return reject(new Error(err));
        }
        console.log("  IDDDD  DEtail Product", id);
        console.log("  DEtail Product", result);
        // 2. Formatez le résultat selon la structure souhaitée
        let formattedResult = {
          id: result[0].id,
          name: result[0].name,
          shopid: result[0].shopid,
          description: result[0].description,
          categoryid: result[0].category,
          price: result[0].price,
          stock: result[0].stock,
          image: result[0].image,
          product_customization: [],
        };

        result.forEach((row) => {
          if (row.choice_name) {
            // Nous nous assurons qu'il y a un choix valide pour cette customisation
            let existingCustomization =
              formattedResult.product_customization.find(
                (c) => c.name === row.customization_name
              );

            if (!existingCustomization) {
              let newCustomization = {
                id: row.customization_id,
                name: row.customization_name,
                description: row.customization_description,
                limit_choice: row.customization_limit,
                items: [],
                mandatory: row.customization_mandatory === 1 ? true : false,
              };
              formattedResult.product_customization.push(newCustomization);
              existingCustomization = newCustomization;
            }

            existingCustomization.items.push({
              id: row.choice_id,
              name: row.choice_name,
              price: row.choice_price,
            });
          }
        });

        console.log(
          "Formated Detail Product ",
          JSON.stringify(formattedResult)
        );

        // 3. Retournez le résultat formaté
        resolve([formattedResult]);
      }
    );
  });
};
module.exports = {
  mAddProduct: (data) => {
    const productData = { ...data };
    delete productData.product_customization; // remove the product_customization as it's not a field in products table
    console.log("Add Product DAta", data);
    return new Promise((resolve, reject) => {
      conn.query("INSERT INTO products SET ?", productData, (err, result) => {
        if (err) {
          console.log("Erro AddProduct", err);
          return reject(new Error(err));
        }

        // Si nous avons des customizations pour ce produit
        if (
          data.product_customization &&
          data.product_customization.length > 0
        ) {
          console.log("We insert custom data ");
          const productId = result.insertId; // l'ID du produit récemment inséré

          // Utilisez une fonction auto-invoquée pour gérer les insertions de manière asynchrone
          (function insertCustomization(index) {
            const customization = data.product_customization[index];
            console.log("Customization", JSON.stringify(customization));
            conn.query(
              "INSERT INTO product_customization SET ?",
              {
                product_id: productId,
                name: customization.name,
                limit_choice: customization.limit_choice,
                description: customization.description,
                mandatory: customization.mandatory ? 1 : 0, // Si mandatory est un champ booléen
              },
              (err, result) => {
                if (err) {
                  console.log("Err", err);
                  return reject(new Error(err));
                }

                const customizationId = result.insertId;

                // Insérer les choix pour cette customisation
                if (customization.items && customization.items.length > 0) {
                  customization.items.forEach((item, itemIndex) => {
                    console.log("Item Choice", item);
                    conn.query(
                      "INSERT INTO product_choice SET ?",
                      {
                        product_customization_id: customizationId,
                        name: item.name,
                        price: item.price,
                      },
                      (err) => {
                        if (err) {
                          return reject(new Error(err));
                        }

                        // Si c'est le dernier élément
                        if (itemIndex === customization.items.length - 1) {
                          // Si c'est la dernière customisation
                          if (index === data.product_customization.length - 1) {
                            resolve(true);
                          } else {
                            // Sinon, passez à la customisation suivante
                            insertCustomization(index + 1);
                          }
                        }
                      }
                    );
                  });
                } else if (index === data.product_customization.length - 1) {
                  resolve(true);
                } else {
                  insertCustomization(index + 1);
                }
              }
            );
          })(0); // Commencez par la première customisation
        } else {
          resolve(true);
        }
      });
    });
  },
  mDetailProduct,
  //   mAddProduct: (data) => {
  //   console.log("New to Product To Database",   data);
  //   return new Promise((resolve, reject) => {
  //     conn.query("INSERT INTO products SET ?", data, (err, result) => {
  //       if (!err) {
  //         resolve(result);
  //       } else {
  //         reject(new Error(err));
  //       }
  //     });
  //   });
  // },
  // mAllProduct: (shopid) => {
  //   return new Promise((resolve, reject) => {
  //     conn.query(
  //       `SELECT *, products.id AS id, products.name AS name, category.name AS category FROM products LEFT JOIN category ON products.categoryId=category.id WHERE products.shopid = ?`,
  //       [shopid],
  //       (err, result) => {
  //         if (!err) {

  //           resolve(result);
  //         } else {
  //           reject(new Error(err));
  //         }
  //       }
  //     );
  //   });
  // },

  // mDetailProduct: (id) => {
  //   return new Promise((resolve, reject) => {
  //     conn.query(
  //       `SELECT products.*, category.name AS category, product_customization.*, product_choice.*
  //            FROM products
  //            LEFT JOIN category ON products.categoryId=category.id
  //            LEFT JOIN product_customization ON products.id=product_customization.product_id
  //            LEFT JOIN product_choice ON product_customization.id=product_choice.product_customization_id
  //            WHERE products.id = ?`,
  //       [id],
  //       (err, result) => {
  //         if (err) {
  //           return reject(new Error(err));
  //         }
  //         // Vous devrez peut-être reformater le résultat ici pour organiser les données correctement
  //         resolve(result);
  //       }
  //     );
  //   });
  // },
  mAllProduct: (shopid) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT id FROM products WHERE products.shopid = ?`,
        [shopid],
        (err, result) => {
          if (!err) {
            const promises = result.map((row) => mDetailProduct(row.id));

            Promise.all(promises)
              .then((allDetailedProducts) => {
                // Aplatir le tableau de tableaux en un tableau simple
                const flattenedArray = [].concat(...allDetailedProducts);
                console.log("AllDetailedProduct", flattenedArray);
                resolve(flattenedArray);
              })
              .catch((err) => {
                reject(new Error(err));
              });
          } else {
            reject(new Error(err));
          }
        }
      );
    });
  },
  // mDetailProduct: (id) => {
  //   return new Promise((resolve, reject) => {
  //     conn.query(
  //       "SELECT *, products.id AS id, products.name AS name, products.description AS description,  category.name AS category FROM products LEFT JOIN category ON products.categoryId=category.id WHERE products.id = ?",
  //       [id],
  //       (err, result) => {
  //         if (!err) {
  //           resolve(result);
  //         } else {
  //           reject(new Error(err));
  //         }
  //       }
  //     );
  //   });
  // },
  // mUpdateProduct: (data, id) => {
  //   console.log("DAta To Update ", data);
  //   return new Promise((resolve, reject) => {
  //     conn.query(
  //       "UPDATE products SET ? WHERE id = ?",
  //       [data, id],
  //       (err, result) => {
  //         if (!err) {
  //           resolve(result);
  //         } else {
  //           reject(new Error(err));
  //         }
  //       }
  //     );
  //   });
  // },
  mUpdateProduct: (data, id) => {
    console.log("Data", data);
    return new Promise((resolve, reject) => {
      // Extraire les informations du produit
      const productData = { ...data };
      delete productData.product_customization;

      // Mettre à jour le produit principal
      conn.query(
        "UPDATE products SET ? WHERE id = ?",
        [productData, id],
        (err, result) => {
          if (err) {
            return reject(new Error(err));
          }

          // Gérer les customisations
          const customizations = data.product_customization || [];
          if (customizations.length === 0) {
            return resolve(true);
          }

          let handledCustomizations = 0;
          customizations.forEach((customization) => {
            console.log("customization", customization);
            // Extraire les choix de la customisation
            const choices = customization.items || [];
            delete customization.items;

            // Si l'identifiant de customisation est présent, mettez à jour, sinon insérez.
            const handleChoices = (customizationId) => {
              if (choices.length === 0) {
                handledCustomizations += 1;
                if (handledCustomizations === customizations.length) {
                  resolve(true);
                }
                return;
              }

              let handledChoices = 0;
              choices.forEach((choice) => {
                if (choice.id) {
                  conn.query(
                    "UPDATE product_choice SET ? WHERE id = ?",
                    [choice, choice.id],
                    (err) => {
                      if (err) {
                        console.log(err);
                        return reject(new Error(err));
                      }
                      handledChoices += 1;
                      if (handledChoices === choices.length) {
                        handledCustomizations += 1;
                        if (handledCustomizations === customizations.length) {
                          resolve(true);
                        }
                      }
                    }
                  );
                } else {
                  choice.product_customization_id = customizationId;
                  conn.query(
                    "INSERT INTO product_choice SET ?",
                    choice,
                    (err) => {
                      if (err) {
                        console.log(err);

                        return reject(new Error(err));
                      }
                      handledChoices += 1;
                      if (handledChoices === choices.length) {
                        handledCustomizations += 1;
                        if (handledCustomizations === customizations.length) {
                          resolve(true);
                        }
                      }
                    }
                  );
                }
              });
            };

            if (customization.id) {
              conn.query(
                "UPDATE product_customization SET ? WHERE id = ?",
                [customization, customization.id],
                (err) => {
                  if (err) {
                    console.log(err);
                    return reject(new Error(err));
                  }
                  handleChoices(customization.id);
                }
              );
            } else {
              customization.product_id = id;
              conn.query(
                "INSERT INTO product_customization SET ?",
                customization,
                (err, result) => {
                  if (err) {
                    console.log(err);
                    return reject(new Error(err));
                  }
                  handleChoices(result.insertId);
                }
              );
            }
          });
        }
      );
    });
  },
  mDeleteProduct: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "SELECT id FROM product_customization WHERE product_id = ? ",
        [id],
        (err, result) => {
          if (!err) {
            console.log("Result delete product", result);
            result.forEach((row) => {
              conn.query(
                "DELETE FROM product_choice WHERE product_customization_id = ? ",
                row.id,
                (err) => {
                  if (err) {
                    console.log(err);
                    return reject(new Error(err));
                  }
                }
              );
            });
            result.forEach((row) => {
              conn.query(
                "DELETE FROM product_customization WHERE id = ? ",
                row.id,
                (err) => {
                  if (err) {
                    console.log(err);
                    return reject(new Error(err));
                  }
                }
              );
            });
            conn.query(
              "DELETE FROM products WHERE id = ?",
              id,
              (err, result) => {
                if (err) {
                  console.log(err);
                  return reject(new Error(err));
                } else resolve({ message: "Products deleted", result });
              }
            );
            resolve(result);
          } else {
            console.log("Error", err);
            reject(new Error(err));
          }
        }
      );

      // conn.query("DELETE FROM products WHERE id = ?", [id], (err, result) => {
      //   if (!err) {
      //     resolve(result);
      //   } else {
      //     reject(new Error(err));
      //   }
      // });
    });
  },
};
