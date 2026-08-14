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
        },
      );
    });
  },
  mFindUserByEmail: (email) => {
    return new Promise((resolve, reject) => {
      conn.query("SELECT * FROM users WHERE email = ?", [email], (err, result) => {
        if (!err) {
          resolve(result);
        } else {
          reject(err);
        }
      });
    });
  },
  mFindUserByStaffLoginId: (staffLoginId) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "SELECT * FROM users WHERE staff_login_id = ?",
        [staffLoginId],
        (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(err);
          }
        },
      );
    });
  },
  mFindUserByIdAndShop: (id, shopid) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "SELECT users.id, users.shopid, users.access, users.staff_login_id, CASE WHEN shop.admin_user = users.id THEN 1 ELSE 0 END AS is_primary_admin FROM users LEFT JOIN shop ON shop.id = users.shopid WHERE users.id = ? AND users.shopid = ?",
        [id, shopid],
        (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(err);
          }
        },
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
          reject(err);
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
        },
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
        },
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
        },
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
        `SELECT id,shopid, username, email, token, expired, phone, gender, position, image, status, access, created, updated FROM users WHERE token='${token}'`,
        (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(new Error(error));
          }
        },
      );
    });
  },
  mGetAllUser: (shopid) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "SELECT users.id, users.shopid, users.username, users.email, users.phone, users.gender, users.position, users.image, users.status, users.access, users.staff_login_id, users.module_permissions, users.created, users.updated, CASE WHEN shop.admin_user = users.id THEN 1 ELSE 0 END AS is_primary_admin FROM users LEFT JOIN shop ON shop.id = users.shopid WHERE users.shopid = ?",
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
        "SELECT users.id, users.shopid, users.username, users.email, users.phone, users.gender, users.position, users.image, users.status, users.access, users.staff_login_id, users.module_permissions, users.created, users.updated, CASE WHEN shop.admin_user = users.id THEN 1 ELSE 0 END AS is_primary_admin FROM users LEFT JOIN shop ON shop.id = users.shopid WHERE users.id = ?",
        [id],
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
  mSessionUser: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "SELECT users.id, users.shopid, users.username, users.email, users.token, users.expired, users.phone, users.gender, users.position, users.image, users.status, users.access, users.staff_login_id, users.module_permissions, users.created, users.updated, CASE WHEN shop.admin_user = users.id THEN 1 ELSE 0 END AS is_primary_admin, counter.id AS service_point_id FROM users LEFT JOIN shop ON shop.id = users.shopid LEFT JOIN service_points AS counter ON counter.shopid = users.shopid AND counter.system_key = 'counter' AND counter.is_active = 1 WHERE users.id = ?",
        [id],
        (err, result) => {
          if (!err) {
            resolve(result);
          } else {
            reject(err);
          }
        },
      );
    });
  },
  mDetailUserWithSecretFields: (id) => {
    return new Promise((resolve, reject) => {
      conn.query(
        "SELECT * FROM users WHERE id = ?",
        [id],
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
        },
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
