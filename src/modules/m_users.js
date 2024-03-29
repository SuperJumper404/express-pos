const conn = require("../config/db");
module.exports = {
  mCheckEmail: (email) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT * FROM users WHERE email='${email}'`,
        (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(new Error(error));
          }
        }
      );
    });
  },
  mRegister: (data) => {
    return new Promise((resolve, reject) => {
      conn.query("INSERT INTO users SET ?", data, (err, result) => {
        if (!err) {
          console.log("GOOD");
          resolve(result);
        } else {
          console.log("Error Ajout Nouveau User", err);
          reject(new Error(err));
        }
      });
    });
  },
  mCreateActivation: (token, email) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "INSERT INTO activation (token, email) VALUES (? , ?)",
        [token, email],
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
  mActivation: (token, email) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "SELECT id FROM activation WHERE token = ? AND email = ?",
        [token, email],
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
  mActivationUser: (email, position, access) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `UPDATE users SET position = ?, status = ?, access = ? WHERE email ='${email}'`,
        [position, 1, access],
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
  mDeleteActivation: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(`DELETE FROM activation WHERE id='${id}'`, (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(new Error(err));
        }
      });
    });
  },
  mProfileMe: (token) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT id,shopid, username, firstname, lastname, email, token, expired, phone, gender, position, image, status, access, created, updated FROM users WHERE token='${token}'`,
        (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(new Error(error));
          }
        }
      );
    });
  },
  mGetAllUser: (shopid) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT * FROM users WHERE shopid = ?`,
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
  modelTotalUser: () => {
    return new Promise((resolve, reject) => {
      conn.query(`SELECT COUNT (*) as total FROM users`, (error, result) => {
        if (!error) {
          collecter;
          resolve(result);
        } else {
          reject(new Error(error));
        }
      });
    });
  },
  mDetailUser: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        `SELECT id, shopid, username, firstname, lastname, email, token, expired, phone, gender, position, image, status, access, created, updated FROM users WHERE id='${id}'`,
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
  mUpdateUser: (data, id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "UPDATE users SET ? WHERE id = ?",
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
  mDeleteUser: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(`DELETE FROM users WHERE id='${id}'`, (error, result) => {
        if (!error) {
          resolve(result);
        } else {
          reject(new Error(error));
        }
      });
    });
  },
};
