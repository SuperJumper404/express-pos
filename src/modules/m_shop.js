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
};
