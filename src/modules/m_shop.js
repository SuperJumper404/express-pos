const conn = require("../config/db");
const { normalizeQrPaymentMode } = require("../helpers/qrPaymentMode");
const { normalizeCommissionPercent } = require("../helpers/stripePayment");
module.exports = {
  mGetShopInfo: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(`SELECT * FROM shop WHERE id=${id}`, (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(new Error(err));
        }
      });
    });
  },
  mCreateAndInitializeShop: (data) => {
    return new Promise((resolve, reject) => {
      if (!data || typeof data !== "object") {
        return reject(new Error("Les donnees du shop sont manquantes"));
      }

      conn.beginTransaction((transactionError) => {
        if (transactionError) {
          return reject(new Error(transactionError.message));
        }

        const shopPayload = {
          shop_name: data.shop_name,
          shop_mail: data.shop_mail,
          shop_phone: data.shop_phone,
          shop_description: data.shop_description,
          shop_payment_methods: JSON.stringify(data.shop_payment_methods),
          shop_adress: data.shop_adress,
          shop_siret: data.shop_siret,
          admin_user: 0,
          admin_phone: data.admin_phone,
          admin_mail: data.admin_mail,
          admin_password: data.admin_password,
          hours: JSON.stringify(data.hours),
          shop_social_media: JSON.stringify(data.shop_social_media),
          shop_profile_image: data.shop_profile_image,
          shop_status: data.shop_status,
          kitchen_closed: data.kitchen_closed || 0,
          shop_printer_ip: data.shop_printer_ip,
          smart_print_app: data.smart_print_app,
          stripe_commission_percent: normalizeCommissionPercent(
            data.stripe_commission_percent,
          ),
        };

        conn.query(
          "INSERT INTO shop SET ?",
          shopPayload,
          (shopError, shopResult) => {
            if (shopError) {
              return conn.rollback(() => {
                reject(new Error(shopError.message));
              });
            }

            const shopId = shopResult.insertId;
            const comptoirPayload = {
              shopid: shopId,
              username: "Comptoir",
              email: data.admin_mail,
              password: data.admin_password,
              token: null,
              expired: null,
              phone: data.admin_phone,
              gender: null,
              position: "Comptoir",
              image: "defaultuser.png",
              status: 1,
              access: 0,
              created: data.created,
              updated: null,
              clearpass: data.admin_password_clear,
            };

            conn.query(
              "INSERT INTO users SET ?",
              comptoirPayload,
              (comptoirError, comptoirResult) => {
                if (comptoirError) {
                  return conn.rollback(() => {
                    reject(new Error(comptoirError.message));
                  });
                }

                const clickAndCollectPayload = {
                  shopid: shopId,
                  username: "Click-and-collect",
                  email: data.click_and_collect_email,
                  password: data.click_and_collect_password,
                  token: null,
                  expired: null,
                  phone: "000000000000",
                  gender: null,
                  position: "Click-and-collect",
                  image: "defaultuser.png",
                  status: 1,
                  access: 3,
                  created: data.created,
                  updated: null,
                  clearpass: data.click_and_collect_clearpass,
                };

                conn.query(
                  "INSERT INTO users SET ?",
                  clickAndCollectPayload,
                  (clickError, clickResult) => {
                    if (clickError) {
                      return conn.rollback(() => {
                        reject(new Error(clickError.message));
                      });
                    }

                    conn.query(
                      "UPDATE shop SET admin_user = ? WHERE id = ?",
                      [comptoirResult.insertId, shopId],
                      (updateError) => {
                        if (updateError) {
                          return conn.rollback(() => {
                            reject(new Error(updateError.message));
                          });
                        }

                        conn.commit((commitError) => {
                          if (commitError) {
                            return conn.rollback(() => {
                              reject(new Error(commitError.message));
                            });
                          }

                          resolve({
                            shopId,
                            comptoirUserId: comptoirResult.insertId,
                            clickAndCollectUserId: clickResult.insertId,
                          });
                        });
                      },
                    );
                  },
                );
              },
            );
          },
        );
      });
    });
  },
  /*
  mUpdateShopInfo: (data, id) => {
    return new Promise((resolve, reject) => {
      try {
        // Vérifier que les données et l'ID sont bien définis
        if (!data || !id) {
          return reject(new Error("Les données ou l'ID sont manquants"));
        }

        // Transformer les objets/arrays en JSON pour stockage en base
        const updateData = {
          shop_name: data.shop_name || "",
          shop_description: data.shop_description || "",
          shop_phone: data.shop_phone || "",
          shop_adress: data.shop_adress || "",
          hours: JSON.stringify(data.shop_hours || []), // Stockage en JSON (jours d'ouverture)
          shop_payment_methods: JSON.stringify(data.shop_payment_methods || []), // Stockage en JSON (moyens de paiement)
        };

        console.log("Données mises à jour :", updateData);

        // Construire la requête SQL avec les bons champs
        const sql = `
          UPDATE shop 
          SET shop_name = ?, shop_description = ?, shop_phone = ?, shop_adress = ?, hours = ?, shop_payment_methods = ? 
          WHERE id = ?
        `;

        // Exécuter la requête SQL avec les bons paramètres
        conn.query(
          sql,
          [
            updateData.shop_name,
            updateData.shop_description,
            updateData.shop_phone,
            updateData.shop_adress,
            updateData.hours,
            updateData.shop_payment_methods,
            id,
          ],
          (err, result) => {
            if (!err) {
              resolve(result);
            } else {
              reject(new Error("Erreur SQL : " + err.message));
            }
          }
        );
      } catch (error) {
        reject(new Error("Erreur interne: " + error.message));
      }
    });
  },*/
  mUpdateShopInfo: (data, id) => {
    return new Promise((resolve, reject) => {
      if (!data || typeof data !== "object" || !id) {
        return reject(new Error("Les données ou l'ID sont manquants"));
      }

      const sql = `
  UPDATE shop
  SET
    shop_name = ?,
    shop_description = ?,
    shop_phone = ?,
    shop_adress = ?,
    shop_siret = ?,
    activate_tva = ?,
    hours = ?,
    shop_social_media = ?,
    shop_payment_methods = ?,
    shop_profile_image = ?,
    shop_status = ?,
    kitchen_closed = ?,
    shop_printer_ip = ?,
    smart_print_app = ?,
    qr_payment_mode = ?,
    stripe_commission_percent = ?,
    stripe_account_id = ?,
    stripe_onboarding_complete = ?,
    stripe_charges_enabled = ?,
    stripe_payouts_enabled = ?
  WHERE id = ?
`;
      const values = [
        data.shop_name,
        data.shop_description,
        data.shop_phone,
        data.shop_adress,
        data.shop_siret,
        data.activate_tva,
        JSON.stringify(data.hours),
        JSON.stringify(data.shop_social_media),
        JSON.stringify(data.shop_payment_methods),
        data.shop_profile_image,
        data.shop_status,
        data.kitchen_closed,
        data.shop_printer_ip,
        data.smart_print_app,
        normalizeQrPaymentMode(data.qr_payment_mode),
        normalizeCommissionPercent(data.stripe_commission_percent),
        data.stripe_account_id,
        data.stripe_onboarding_complete,
        data.stripe_charges_enabled,
        data.stripe_payouts_enabled,
        id, // ou req.shopid si c’est ça ta variable
      ];

      console.log("Data to update", data);
      conn.query(sql, values, (err, result) => {
        if (err) {
          reject(new Error("Erreur SQL : " + JSON.stringify(err.message)));
        } else {
          resolve(result);
        }
      });
    });
  },
  mUpdateStripeAccount: (id, data) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `UPDATE shop
         SET stripe_account_id = ?,
             stripe_onboarding_complete = ?,
             stripe_charges_enabled = ?,
             stripe_payouts_enabled = ?
         WHERE id = ?`,
        [
          data.stripe_account_id,
          data.stripe_onboarding_complete ? 1 : 0,
          data.stripe_charges_enabled ? 1 : 0,
          data.stripe_payouts_enabled ? 1 : 0,
          id,
        ],
        (err, result) => {
          if (err) {
            reject(new Error(err.message));
          } else {
            resolve(result);
          }
        },
      );
    });
  },
};
