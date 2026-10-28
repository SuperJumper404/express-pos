const { custom, failed } = require("../response");
const jwt = require("jsonwebtoken");
const { envJWTKEY } = require("../env");
const { parseModulePermissions } = require("../staffPermissions");
const { assertStaffSurface } = require("../deliveryAuthorization");
const prefix = require("../../config/prefix");
const relativeStaffPath = req => {
  const path = (req.originalUrl || req.path || "/").split("?")[0];
  return path.toLowerCase().startsWith(prefix.toLowerCase() + "/") ? path.slice(prefix.length) : path;
};

const STAFF_ACCESS = new Set([0, 1, 4, 5]);
const defaultFindUserByIdAndShop = async ({ id, shopId }) => {
  const pool = require("../../config/dbPool");
  const [rows] = await pool.query(
    `SELECT id, shopid, username, access, status, module_permissions, token
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
const buildAuthentication = ({ findUserByIdAndShop = defaultFindUserByIdAndShop } = {}) => (req, res, next) => {
  const authorization = req.headers.authorization;
  if (!authorization) return custom(res, 401, "Token requis, veuillez vous reconnecter.", {}, null);
  let decoded;
  try { decoded = jwt.verify(authorization.split(" ")[1], envJWTKEY); }
  catch (error) { return failed(res, "Session expired", "SESSION_EXPIRED", 401); }
  const surfacePath = relativeStaffPath(req);
  let accountSegments;
  try { accountSegments = surfacePath.replace(/\/$/, "").split("/").map(segment => decodeURIComponent(segment).toLowerCase()); }
  catch (error) { return custom(res, 400, "Invalid request path", {}, null); }
  const accountWrite = (req.method === "POST" && accountSegments.length === 2 && accountSegments[1] === "register") ||
    (["PATCH", "PUT", "DELETE"].includes(req.method) && accountSegments[1] === "user");
  req.shopid = decoded.shopid;
  if (decoded.subject_type === "service_point") {
    if (accountWrite) return custom(res, 403, "Access denied", {}, null);
    req.access = decoded.access;
    req.sessionSubject = "service_point";
    req.servicePointId = decoded.service_point_id;
    req.orderSource = decoded.source;
    req.id = null;
    req.email = null;
    return next();
  }
  if ((decoded.subject_type && decoded.subject_type !== "staff") ||
    (decoded.subject && decoded.subject !== "staff") || !decoded.id || !decoded.shopid) return custom(res, 403, "Access denied", {}, null);
  return (async () => {
    try {
      const user = await findUserByIdAndShop({ id: decoded.id, shopId: req.shopid });
      if (!user || user.access == null || Number(user.status) !== 1) return custom(res, 403, "Access denied", {}, null);
      req.id = user.id;
      req.access = Number(user.access);
      req.email = decoded.email;
      req.sessionSubject = "staff";
      req.currentUser = user;
      assertStaffSurface({ access: req.access, method: req.method, path: surfacePath });
      if (req.access !== 0 && accountWrite) {
        return custom(res, 403, "Access denied", {}, null);
      }
      return next();
    } catch (error) {
      return failed(res, "Access denied", error.code === "DELIVERY_FORBIDDEN" ? error.code : "AUTH_UNAVAILABLE", error.status || 503);
    }
  })();
};
const authentication = buildAuthentication();
const authenticationIfPresent = (req, res, next) => {
  const path = relativeStaffPath(req);
  // Credential/proof entry points must remain usable with an expired staff header.
  if (req.method === "POST" && (/^\/(login|table-access)\/?$/i.test(path) ||
    /^\/shopInfo\/click-and-collect\/[^/]+\/session\/?$/i.test(path))) return next();
  return req.headers.authorization ? authentication(req, res, next) : next();
};
module.exports = {
  buildAuthentication,
  authenticationIfPresent,
  buildModuleAuthorization,
  authorizeStocks,
  authorizeCashRegister,
  authentication,
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
