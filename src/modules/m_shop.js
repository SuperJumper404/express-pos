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
  },
};
