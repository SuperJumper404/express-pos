const conn = require("../config/db");
const { normalizeQrPaymentMode } = require("../helpers/qrPaymentMode");
const { normalizeCommissionPercent } = require("../helpers/stripePayment");

const transactionError = (conn, reject, error) =>
  conn.rollback(() => reject(new Error(error.message)));

const mGetShopInfo = (id) =>
  new Promise((resolve, reject) => {
    conn.query("SELECT * FROM shop WHERE id = ?", [id], (error, result) => {
      if (error) return reject(new Error(error.message));
      resolve(result);
    });
  });

const mCreateAndInitializeShop = (data) =>
  new Promise((resolve, reject) => {
    if (!data || typeof data !== "object") {
      return reject(new Error("Les donnees du shop sont manquantes"));
    }

    conn.beginTransaction((beginError) => {
      if (beginError) return reject(new Error(beginError.message));

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
        auto_print_order_tickets: data.auto_print_order_tickets || 0,
        stripe_commission_percent: normalizeCommissionPercent(
          data.stripe_commission_percent,
        ),
      };

      conn.query("INSERT INTO shop SET ?", shopPayload, (shopError, shopResult) => {
        if (shopError) return transactionError(conn, reject, shopError);

        const shopId = shopResult.insertId;
        const adminPayload = {
          shopid: shopId,
          username: data.admin_username || "Administrateur",
          email: data.admin_mail,
          password: data.admin_password,
          token: null,
          expired: null,
          phone: data.admin_phone,
          gender: null,
          position: "Administrateur",
          image: "defaultuser.png",
          status: 1,
          access: 0,
          created: data.created,
          updated: null,
          clearpass: data.admin_password_clear,
        };

        conn.query("INSERT INTO users SET ?", adminPayload, (adminError, adminResult) => {
          if (adminError) return transactionError(conn, reject, adminError);

          const counterPayload = {
            shopid: shopId,
            name: "Comptoir",
            type: "counter",
            system_key: "counter",
            is_system: 1,
            is_active: 1,
            sort_order: 0,
            public_access_version: 1,
            created: data.created,
            updated: null,
          };

          conn.query(
            "INSERT INTO `service_points` SET ?",
            counterPayload,
            (counterError, counterResult) => {
              if (counterError) return transactionError(conn, reject, counterError);

              const clickAndCollectPayload = {
                shopid: shopId,
                name: "Click & Collect",
                type: "click_collect",
                system_key: "click_collect",
                is_system: 1,
                is_active: 1,
                sort_order: 1,
                public_access_version: 1,
                created: data.created,
                updated: null,
              };

              conn.query(
                "INSERT INTO `service_points` SET ?",
                clickAndCollectPayload,
                (clickError, clickResult) => {
                  if (clickError) return transactionError(conn, reject, clickError);

                  conn.query(
                    "UPDATE shop SET admin_user = ? WHERE id = ?",
                    [adminResult.insertId, shopId],
                    (updateError) => {
                      if (updateError) return transactionError(conn, reject, updateError);

                      conn.commit((commitError) => {
                        if (commitError) return transactionError(conn, reject, commitError);
                        resolve({
                          shopId,
                          adminUserId: adminResult.insertId,
                          counterServicePointId: counterResult.insertId,
                          clickAndCollectServicePointId: clickResult.insertId,
                        });
                      });
                    },
                  );
                },
              );
            },
          );
        });
      });
    });
  });

const mUpdateShopInfo = (data, id) =>
  new Promise((resolve, reject) => {
    if (!data || typeof data !== "object" || !id) {
      return reject(new Error("Les donnees ou l'ID sont manquants"));
    }

    const sql = `
      UPDATE shop
      SET shop_name = ?, shop_description = ?, shop_phone = ?, shop_adress = ?,
          shop_siret = ?, activate_tva = ?, hours = ?, shop_social_media = ?,
          shop_payment_methods = ?, shop_profile_image = ?, shop_status = ?,
          kitchen_closed = ?, shop_printer_ip = ?, smart_print_app = ?,
          auto_print_order_tickets = ?, qr_payment_mode = ?, stripe_commission_percent = ?,
          stripe_account_id = ?, stripe_onboarding_complete = ?, stripe_charges_enabled = ?,
          stripe_payouts_enabled = ?
      WHERE id = ?`;
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
      data.auto_print_order_tickets,
      normalizeQrPaymentMode(data.qr_payment_mode),
      normalizeCommissionPercent(data.stripe_commission_percent),
      data.stripe_account_id,
      data.stripe_onboarding_complete,
      data.stripe_charges_enabled,
      data.stripe_payouts_enabled,
      id,
    ];

    conn.query(sql, values, (error, result) => {
      if (error) return reject(new Error(`Erreur SQL : ${error.message}`));
      resolve(result);
    });
  });

const mUpdateStripeAccount = (id, data) =>
  new Promise((resolve, reject) => {
    conn.query(
      `UPDATE shop
       SET stripe_account_id = ?, stripe_onboarding_complete = ?,
           stripe_charges_enabled = ?, stripe_payouts_enabled = ?
       WHERE id = ?`,
      [
        data.stripe_account_id,
        data.stripe_onboarding_complete ? 1 : 0,
        data.stripe_charges_enabled ? 1 : 0,
        data.stripe_payouts_enabled ? 1 : 0,
        id,
      ],
      (error, result) => {
        if (error) return reject(new Error(error.message));
        resolve(result);
      },
    );
  });

module.exports = {
  mGetShopInfo,
  mCreateAndInitializeShop,
  mUpdateShopInfo,
  mUpdateStripeAccount,
};
