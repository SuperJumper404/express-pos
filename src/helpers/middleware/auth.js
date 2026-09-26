const { custom, failed } = require("../response");
const jwt = require("jsonwebtoken");
const { envJWTKEY } = require("../env");
const { parseModulePermissions } = require("../staffPermissions");

const STAFF_ACCESS = new Set([0, 1, 4, 5]);
const defaultFindUserByIdAndShop = async ({ id, shopId }) => {
  const pool = require("../../config/dbPool");
  const [rows] = await pool.query(
    `SELECT id, access, status, module_permissions
     FROM users
     WHERE id = ? AND shopid = ?
     LIMIT 1`,
    [id, shopId],
  );
  return rows[0] || null;
};

const buildModuleAuthorization = ({
  moduleKey,
  findUserByIdAndShop = defaultFindUserByIdAndShop,
}) => async (req, res, next) => {
  if (req.sessionSubject === "service_point" || !STAFF_ACCESS.has(Number(req.access))) {
    return custom(res, 403, "Acces refuse.", {}, null);
  }
  if (Number(req.access) === 0) return next();
  try {
    const user = await findUserByIdAndShop({ id: req.id, shopId: req.shopid });
    const permissions = user && Number(user.status) === 1
      ? parseModulePermissions(user.module_permissions, user.access)
      : null;
    if (Array.isArray(permissions) && permissions.includes(moduleKey)) return next();
    return custom(res, 403, "Acces refuse.", {}, null);
  } catch (error) {
    return failed(res, "Erreur serveur.", moduleKey === "cashregister" ? "TERMINAL_INTERNAL_ERROR" : error.message);
  }
};

const authorizeStocks = buildModuleAuthorization({ moduleKey: "stocks" });
const authorizeCashRegister = buildModuleAuthorization({ moduleKey: "cashregister" });
module.exports = {
  buildModuleAuthorization,
  authorizeStocks,
  authorizeCashRegister,
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
