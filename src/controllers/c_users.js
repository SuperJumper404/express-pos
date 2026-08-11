const {
  mCheckEmail,
  mFindUserByEmail,
  mFindUserByStaffLoginId,
  mFindUserByIdAndShop,
  mRegister,
  mActivation,
  mActivationUser,
  mDeleteActivation,
  mProfileMe,
  mGetAllUser,
  mDetailUser,
  mSessionUser,
  mDetailUserWithSecretFields,
  mUpdateUser,
  mDeleteUser,
} = require("../modules/m_users");
const { custom, success, failed } = require("../helpers/response");
const { envJWTKEY } = require("../helpers/env");
const {
  signTableAccessToken,
  verifyTableAccessToken,
  signTableSessionToken,
} = require("../helpers/tableAccessToken");
const { buildTableAccessLoginData } = require("../helpers/tableAccessLoginData");
const mailer = require("../helpers/mailer");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const {
  createStaffLoginId,
  createStaffPin,
  normalizeStaffLoginId,
  hashStaffPin,
  verifyStaffPin,
} = require("../helpers/staffCredentials");
const {
  normalizeModulePermissions,
  parseModulePermissions,
} = require("../helpers/staffPermissions");

const STAFF_ACCESS_VALUES = new Set([0, 1, 4, 5]);
const isStaffAccess = (access) => STAFF_ACCESS_VALUES.has(Number(access));
const invalidCredentials = (res) =>
  custom(res, 422, "Identifiant ou code incorrect.", {}, null);
const withModulePermissions = (user) => ({
  ...user,
  module_permissions: parseModulePermissions(
    user.module_permissions,
    user.access,
  ),
});
const findActiveAdminByPassword = async (users, password) => {
  let legacyUser = null;
  for (const user of users) {
    const activeAdmin =
      Number(user.access) === 0 && Number(user.status) === 1;
    if (!activeAdmin) {
      continue;
    }
    if (await bcrypt.compare(password, user.password)) {
      return { user, legacyPassword: false };
    }
    if (user.clearpass && password === user.clearpass) {
      legacyUser = user;
    }
  }
  return legacyUser ? { user: legacyUser, legacyPassword: true } : null;
};

const createSession = async (user) => {
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      access: user.access,
      shopid: user.shopid,
    },
    envJWTKEY,
    { expiresIn: "1d" },
  );
  const expired = new Date();
  expired.setDate(expired.getDate() + 1);
  await mUpdateUser(
    {
      token,
      expired: expired.toISOString().substring(0, 10),
      updated: new Date(),
    },
    user.id,
  );
  const sessionUsers = await mSessionUser(user.id);
  return sessionUsers.map(withModulePermissions);
};

const createInternalPassword = () =>
  `${createStaffLoginId()}${createStaffLoginId()}`;

const registerWithStaffCredentials = async (req, res) => {
  try {
    const body = req.body || {};
    const access = Number(body.access);
    const staffAccount = isStaffAccess(access);
    const email = String(body.email || "").trim();

    if (!staffAccount) {
      const existingUsers = await mFindUserByEmail(email);
      if (existingUsers.length >= 1) {
        return custom(res, 422, "Cet email est deja enregistre.", {}, null);
      }
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const staffLoginId = staffAccount ? createStaffLoginId() : null;
      const staffPin = staffAccount ? createStaffPin() : null;
      const passwordInput = staffAccount
        ? createInternalPassword()
        : body.password || createInternalPassword();
      const data = {
        username: body.username,
        phone: body.phone || "",
        email,
        password: await bcrypt.hash(passwordInput, 10),
        clearpass: "",
        access,
        status: body.status == null ? 1 : Number(body.status),
        token: null,
        shopid: req.shopid,
        created: new Date(),
      };

      if (staffAccount) {
        data.staff_login_id = staffLoginId;
        data.staff_pin_hash = await hashStaffPin(staffPin);
        data.module_permissions = JSON.stringify(
          normalizeModulePermissions(body.module_permissions, access),
        );
      }

      try {
        await mRegister(data);
        return success(
          res,
          "Compte cree avec succes.",
          {},
          staffAccount
            ? { staff_login_id: staffLoginId, staff_pin: staffPin }
            : null,
        );
      } catch (error) {
        if (!(staffAccount && error.code === "ER_DUP_ENTRY" && attempt < 4)) {
          throw error;
        }
      }
    }

    return failed(res, "Erreur serveur.", "Impossible de generer un ID unique.");
  } catch (error) {
    return failed(res, "Erreur serveur.", error.message);
  }
};

const setStaffCredentials = async (req, res) => {
  try {
    const users = await mFindUserByIdAndShop(req.params.id, req.shopid);
    const user = users[0];
    if (
      !user ||
      !isStaffAccess(user.access) ||
      Number(user.is_primary_admin) === 1
    ) {
      return custom(res, 404, "Utilisateur introuvable.", {}, null);
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const staffLoginId = user.staff_login_id || createStaffLoginId();
      const staffPin = createStaffPin();
      try {
        await mUpdateUser(
          {
            staff_login_id: staffLoginId,
            staff_pin_hash: await hashStaffPin(staffPin),
            updated: new Date(),
          },
          user.id,
        );
        return success(res, "Identifiants caisse mis a jour.", {}, {
          staff_login_id: staffLoginId,
          staff_pin: staffPin,
        });
      } catch (error) {
        if (!(error.code === "ER_DUP_ENTRY" && attempt < 4)) {
          throw error;
        }
      }
    }

    return failed(res, "Erreur serveur.", "Impossible de generer un ID unique.");
  } catch (error) {
    return failed(res, "Erreur serveur.", error.message);
  }
};

const loginWithStaffCredentials = async (req, res) => {
  try {
    const body = req.body || {};
    let user;
    let valid = false;

    if (body.staff_login_id) {
      const users = await mFindUserByStaffLoginId(
        normalizeStaffLoginId(body.staff_login_id),
      );
      user = users.length === 1 ? users[0] : null;
      valid = Boolean(
        user &&
          isStaffAccess(user.access) &&
          user.status === 1 &&
          user.staff_pin_hash &&
          (await verifyStaffPin(String(body.pin || ""), user.staff_pin_hash)),
      );
    } else {
      const users = await mFindUserByEmail(String(body.email || "").trim());
      const adminLogin = await findActiveAdminByPassword(
        users,
        String(body.password || ""),
      );
      user = adminLogin ? adminLogin.user : null;
      valid = Boolean(user);
      if (adminLogin && adminLogin.legacyPassword) {
        await mUpdateUser(
          {
            password: await bcrypt.hash(String(body.password), 10),
            clearpass: "",
            updated: new Date(),
          },
          user.id,
        );
      }
    }

    if (!valid) return invalidCredentials(res);

    const sessionUser = await createSession(user);
    return success(res, "Connexion reussie !", null, sessionUser);
  } catch (error) {
    return failed(res, "Erreur serveur.", error.message);
  }
};

module.exports = {
  registerWithStaffCredentials,
  loginWithStaffCredentials,
  setStaffCredentials,
  register: (req, res) => {
    const body = req.body;
    mCheckEmail(body.email)
      .then(async (response) => {
        if (response.length >= 1) {
          custom(res, 422, "Cet email est déjà enregistré.", {}, null);
        } else {
          console.log("Adding USer");
          const salt = await bcrypt.genSaltSync(10);
          const password = await bcrypt.hashSync(body.password, salt);
          const token = jwt.sign(
            { username: body.username, phone: body.phone, create: new Date() },
            envJWTKEY,
          );
          const data = {
            username: body.username,
            phone: body.phone,
            email: body.email,
            password,
            clearpass: body.password,
            access: body.access,
            status: 1,
            token: token,
            shopid: req.shopid,
            created: new Date(),
          };
          // create token

          mRegister(data)
            .then(() => {
              console.log("Double Good");
              success(res, "Compte créé avec succès.", {}, null);
              // mCreateActivation(token, body.email).then(() => {
              //   // send email
              //   mailer.register(body.email, body.username, token).then(() => {
              //     success(res, 'Check inbox or spam your email for verification!', {}, null)
              //   }).catch((error) => {
              //     failed(res, 'Mailer error!', error.message)
              //   })
              // }).catch((error) => {
              //   failed(res, 'Internal Server Error!', error.message)
              // })
            })
            .catch((error) => {
              failed(res, "Erreur serveur.", error.message);
            });
        }
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  activation: (req, res) => {
    const token = req.params.token;
    const email = req.params.email;
    const position = req.params.position;
    const access = req.params.access;
    mActivation(token, email)
      .then((response) => {
        mActivationUser(email, position, access)
          .then(() => {
            mDeleteActivation(response[0].id)
              .then(() => {
                success(res, "Compte activé.", {}, null);
              })
              .catch((error) => {
                failed(res, "Erreur serveur.", error.message);
              });
          })
          .catch((error) => {
            failed(res, "Erreur serveur.", error.message);
          });
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  login: (req, res) => {
    console.log("Login body", req.body);
    const body = req.body;
    mCheckEmail(body.email)
      .then(async (response) => {
        if (response.length === 1) {
          const hash = await response[0].password;
          // const checkPass = await bcrypt.compareSync(body.password, hash)
          const checkPass = body.password === response[0].clearpass;
          if (checkPass) {
            if (response[0].status === 1) {
              const data = {
                id: response[0].id,
                email: response[0].email,
                access: response[0].access,
                shopid: response[0].shopid,
              };
              // const token = jwt.sign(data, envJWTKEY, { expiresIn: "8000" });
              const token = jwt.sign(data, envJWTKEY, { expiresIn: "1d" });
              const expired = new Date();
              expired.setDate(expired.getDate() + 1);
              const newData = {
                token,
                expired: expired.toISOString().substring(0, 10),
                updated: new Date(),
              };
              // update token and expired
              mUpdateUser(newData, response[0].id).then(() => {
                // send response user by id
                mDetailUser(response[0].id)
                  .then((response) => {
                    success(res, "Connexion réussie !", null, response);
                  })
                  .catch((error) => {
                    failed(res, "Erreur serveur.", error.message);
                  });
              });
            } else {
              custom(
                res,
                422,
              `Votre compte n'est pas encore activé ! Vérifiez votre email.`,
                {},
                null,
              );
            }
          } else {
            custom(res, 422, "Votre mot de passe est incorrect.", {}, null);
          }
        } else {
          custom(res, 422, "Votre email n'est pas enregistré.", {}, null);
        }
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  tableAccess: async (req, res) => {
    try {
      const token = req.body && req.body.token;
      if (!token) {
        return custom(res, 422, "Token QR requis.", {}, null);
      }

      const decoded = verifyTableAccessToken(token);
      const users = await mDetailUserWithSecretFields(decoded.id);
      const user = users && users[0];
      buildTableAccessLoginData({
        decoded,
        user,
        sessionToken: "",
      });
      const sessionToken = signTableSessionToken(user);
      const expired = new Date();
      expired.setHours(expired.getHours() + 4);

      const data = {
        token: sessionToken,
        expired: expired.toISOString().substring(0, 10),
        updated: new Date(),
      };

      await mUpdateUser(data, user.id);

      const loginData = buildTableAccessLoginData({
        decoded,
        user: { ...user, token: sessionToken, expired: data.expired },
        sessionToken,
      });

      return success(res, "Connexion table reussie !", null, loginData);
    } catch (error) {
      return custom(res, 401, error.message || "Token QR invalide.", {}, null);
    }
  },
  logout: (req, res) => {
    const id = req.body.id;
    const data = {
      token: null,
      expired: null,
      updated: new Date(),
    };
    mUpdateUser(data, id)
      .then((response) => {
        if (response.affectedRows) {
          success(res, "Déconnexion réussie !", {}, true);
        } else {
          custom(res, 404, "Utilisateur non trouvé !", null, false);
        }
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  profileMe: (req, res) => {
    const authorization = req.headers.authorization;
    const token = authorization.split(" ");
    mProfileMe(token[1])
      .then((response) => {
        success(res, "Profil récupéré.", null, response);
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  getAllUser: async (req, res) => {
    mGetAllUser(req.shopid)
      .then((response) => {
        const users = response.map((rawUser) => {
          const user = withModulePermissions(rawUser);
          if (![2, 3].includes(Number(user.access))) return user;
          return {
            ...user,
            table_access_token: signTableAccessToken(user),
          };
        });
        success(res, "Utilisateurs récupérés.", null, users);
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  getDetailUser: (req, res) => {
    const id = req.params.id;
    mDetailUser(id)
      .then((response) => {
        success(
          res,
          "Détail utilisateur récupéré.",
          null,
          response.map(withModulePermissions),
        );
      })
      .catch((error) => {
        failed(res, "Erreur serveur.", error.message);
      });
  },
  updateUser: async (req, res) => {
    const body = req.body;
    body.updated = new Date();
    const id = req.params.id;
    const detail = await mDetailUser(id);
    if (Object.prototype.hasOwnProperty.call(body, "module_permissions")) {
      const access =
        body.access === undefined ? detail[0].access : Number(body.access);
      body.module_permissions = JSON.stringify(
        normalizeModulePermissions(body.module_permissions, access),
      );
    }
    if (req.file) {
      if (detail[0].image === "defaultuser.png") {
        body.image = req.file.filename;
        mUpdateUser(body, id)
          .then(() => {
            success(res, "Profil mis à jour avec succès.", {}, null);
          })
          .catch((error) => {
            failed(res, "Erreur serveur.", null || error.message);
          });
      } else {
        body.image = req.file.filename;
        const path = `./public/profile/${detail[0].image}`;
        if (fs.existsSync(path)) {
          fs.unlinkSync(path);
        }
        mUpdateUser(body, id)
          .then(() => {
            success(res, "Profil mis à jour avec succès.", {}, null);
          })
          .catch((error) => {
            failed(res, "Erreur serveur.", null || error.message);
          });
      }
    } else {
      mUpdateUser(body, id)
        .then(() => {
          success(res, "Mise à jour effectuée.", {}, null);
        })
        .catch((error) => {
          failed(res, "Erreur serveur.", error.message);
        });
    }
  },
  deleteUser: async (req, res) => {
    try {
      const id = req.params.id;
      const callDetail = await mDetailUser(id);
      mDeleteUser(id)
        .then((response) => {
          if (response.affectedRows) {
            // select image profile
            if (callDetail[0].image === "defaultuser.png") {
              success(res, "Utilisateur supprimé avec succès.", {}, null);
            } else {
              const locationPath = `./public/profile/${callDetail[0].image}`;
              fs.unlinkSync(locationPath);
              success(res, "Utilisateur supprimé avec succès.", {}, null);
            }
          } else {
            custom(res, 404, "Utilisateur introuvable.", null, null);
          }
        })
        .catch((error) => {
          failed(res, "Erreur serveur.", error.message);
        });
    } catch (error) {
      failed(res, "Erreur serveur.", error.message);
    }
  },
};
