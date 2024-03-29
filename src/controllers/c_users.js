const {
  mCheckEmail,
  mRegister,
  mActivation,
  mActivationUser,
  mDeleteActivation,
  mProfileMe,
  mGetAllUser,
  mDetailUser,
  mUpdateUser,
  mDeleteUser,
} = require("../modules/m_users");
const { custom, success, failed } = require("../helpers/response");
const { envJWTKEY } = require("../helpers/env");
const mailer = require("../helpers/mailer");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const fs = require("fs");

module.exports = {
  register: (req, res) => {
    const body = req.body;
    mCheckEmail(body.email)
      .then(async (response) => {
        if (response.length >= 1) {
          custom(res, 422, "Email has been register!", {}, null);
        } else {
          console.log("Adding USer");
          const salt = await bcrypt.genSaltSync(10);
          const password = await bcrypt.hashSync(body.password, salt);
          const token = jwt.sign(
            { username: body.username, phone: body.phone, create: new Date() },
            envJWTKEY
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
          };
          // create token

          mRegister(data)
            .then(() => {
              console.log("Double Good");
              success("New User Registered");
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
              failed(res, "Internal Server Error!", error.message);
            });
        }
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
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
                success(res, "Activated", {}, null);
              })
              .catch((error) => {
                failed(res, "Internal Server Error!", error.message);
              });
          })
          .catch((error) => {
            failed(res, "Internal Server Error!", error.message);
          });
      })
      .catch((error) => {
        failed(res, "Internal Server Error!", error.message);
      });
  },
  login: (req, res) => {
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
                    success(res, "Login success!", null, response);
                  })
                  .catch((error) => {
                    failed(res, "Internal Server Error!", error.message);
                  });
              });
            } else {
              custom(
                res,
                422,
                `Your account isn't activated yet! Check your email!`,
                {},
                null
              );
            }
          } else {
            custom(res, 422, "Your password is wrong!", {}, null);
          }
        } else {
          custom(res, 422, "Email not registered!", {}, null);
        }
      })
      .catch((error) => {
        failed(res, "Internal Server Error!", error.message);
      });
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
          success(res, "Logout success!", {}, true);
        } else {
          custom(res, 404, "Id user not found!", null, false);
        }
      })
      .catch((error) => {
        failed(res, "Internal Server Error!", error.message);
      });
  },
  profileMe: (req, res) => {
    const authorization = req.headers.authorization;
    const token = authorization.split(" ");
    mProfileMe(token[1])
      .then((response) => {
        success(res, "Data profile!", null, response);
      })
      .catch((error) => {
        failed(res, "Internal Server Error!", error.message);
      });
  },
  getAllUser: async (req, res) => {
    mGetAllUser(req.shopid)
      .then((response) => {
        success(res, "Get all data user", null, response);
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
      });
  },
  getDetailUser: (req, res) => {
    const id = req.params.id;
    mDetailUser(id)
      .then((response) => {
        success(res, "Detail user", null, response);
      })
      .catch((error) => {
        failed(res, "Internal Server Error!", error.message);
      });
  },
  updateUser: async (req, res) => {
    const body = req.body;
    body.updated = new Date();
    const id = req.params.id;
    const detail = await mDetailUser(id);
    if (req.file) {
      if (detail[0].image === "defaultuser.png") {
        body.image = req.file.filename;
        mUpdateUser(body, id)
          .then(() => {
            success(res, "Update profile sucess!", {}, null);
          })
          .catch((error) => {
            failed(res, "Internal server error!", null || error.message);
          });
      } else {
        body.image = req.file.filename;
        const path = `./public/profile/${detail[0].image}`;
        if (fs.existsSync(path)) {
          fs.unlinkSync(path);
        }
        mUpdateUser(body, id)
          .then(() => {
            success(res, "Update profile success", {}, null);
          })
          .catch((error) => {
            failed(res, "Internal server error!", null || error.message);
          });
      }
    } else {
      mUpdateUser(body, id)
        .then(() => {
          success(res, "Update success", {}, null);
        })
        .catch((error) => {
          failed(res, "Internal Server Error!", error.message);
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
              success(res, "Delete success!", {}, null);
            } else {
              const locationPath = `./public/profile/${callDetail[0].image}`;
              fs.unlinkSync(locationPath);
              success(res, "Delete success.", {}, null);
            }
          } else {
            custom(res, 404, "Id user not found!", null, null);
          }
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    } catch (error) {
      failed(res, "Internal server error!", error.message);
    }
  },
};
