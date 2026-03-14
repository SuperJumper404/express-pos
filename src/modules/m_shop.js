const conn = require("../config/db");
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
    hours = ?,
    shop_social_media = ?,
    shop_payment_methods = ?,
    shop_profile_image = ?,
    shop_status = ?,
    shop_printer_ip = ?,
    smart_print_app = ? 
  WHERE id = ?
`;
      const values = [
        data.shop_name,
        data.shop_description,
        data.shop_phone,
        data.shop_adress,
        data.shop_siret,
        JSON.stringify(data.hours),
        JSON.stringify(data.shop_social_media),
        JSON.stringify(data.shop_payment_methods),
        data.shop_profile_image,
        data.shop_status,
        data.shop_printer_ip,
        data.smart_print_app,
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
};
