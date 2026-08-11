const { custom, failed } = require("../response");
const jwt = require("jsonwebtoken");
const { envJWTKEY } = require("../env");
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
          if (decoded.subject_type === "service_point") {
            req.sessionSubject = "service_point";
            req.servicePointId = decoded.service_point_id;
            req.orderSource = decoded.source;
            req.id = null;
            req.email = null;
          } else {
            req.sessionSubject = "staff";
            req.id = decoded.id;
            req.email = decoded.email;
          }
          next();
        } else {
          failed(res, "Session expirée, veuillez vous reconnecter.", error.message, 401);
        }
      });
    } else {
      custom(res, 401, "Token requis, veuillez vous reconnecter.", {}, null);
    }
  },
  authAdmin: (req, res, next) => {
    // console.log("Incomiing rqg ",req)

    const access = req.access;
    if (req.sessionSubject !== "service_point" && access === 0) {
      next();
    } else {
      custom(res, 403, "Accès refusé, réservé aux administrateurs.", {}, null);
    }
  },
  authCashier: (req, res, next) => {
    const access = req.access;
    if (access === 1) {
      next();
    } else {
      custom(res, 403, "Accès refusé, réservé aux caissiers.", {}, null);
    }
  },
  authCustomer: (req, res, next) => {
    const access = req.access;
    if (access === 2) {
      next();
    } else {
      custom(res, 403, "Accès refusé, réservé aux clients.", {}, null);
    }
  },
};
