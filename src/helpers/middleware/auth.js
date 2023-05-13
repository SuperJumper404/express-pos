const { custom } = require("../response");
const jwt = require("jsonwebtoken");
const { envJWTKEY } = require("../env");
console.log("Secret Key JWt", envJWTKEY);
module.exports = {
  authentication: (req, res, next) => {
    const authorization = req.headers.authorization;
    if (authorization) {
      let token = authorization.split(" ");
      jwt.verify(token[1], envJWTKEY, (error, decoded) => {
        // console.log("Incomiing ", decoded);
        if (!error) {
          req.access = decoded.access;
          req.shopid = decoded.shopid;
          req.id = decoded.id;
          req.email = decoded.email;
          next();
        } else {
          res.status(401).send("Expired Token");
        }
      });
    } else {
      custom(res, 401, "Token required!", {}, null);
    }
  },
  authAdmin: (req, res, next) => {
    // console.log("Incomiing rqg ",req)

    const access = req.access;
    if (access === 0) {
      next();
    } else {
      custom(res, 401, "Access denied!, Only for admin", {}, null);
    }
  },
  authCashier: (req, res, next) => {
    const access = req.access;
    if (access === 1) {
      next();
    } else {
      custom(res, 401, "Access denied!, Only for cashier", {}, null);
    }
  },
  authCustomer: (req, res, next) => {
    const access = req.access;
    if (access === 2) {
      next();
    } else {
      custom(res, 401, "Access denied!, Only for customer", {}, null);
    }
  },
};
