const cookie = require("cookie");
const { failed } = require("../response");
const { SESSION_SECONDS } = require("../customerSession");

const cookiePolicy = req => {
  if (req.secure) return { name: "__Host-smarteat_customer", secure: true };
  if (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(req.hostname)) {
    return { name: "smarteat_customer", secure: false };
  }
  return null;
};
const rawCustomerToken = req => {
  const policy = cookiePolicy(req);
  return policy ? cookie.parse(req.headers.cookie || "")[policy.name] : undefined;
};
const setCustomerCookie = (req, res, rawToken, expiresAt) => {
  const policy = cookiePolicy(req);
  if (!policy) return false;
  res.append("Set-Cookie", cookie.serialize(policy.name, rawToken || "", { path: "/", httpOnly: true, secure: policy.secure,
    sameSite: "lax", maxAge: rawToken ? SESSION_SECONDS : 0, expires: rawToken ? new Date(expiresAt) : new Date(0) }));
  return true;
};
const requestedShop = req => {
  const value = req.query && req.query.shopId;
  return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null;
};
const buildCustomerMiddleware = ({ sessions = require("../customerSession").buildCustomerSession() } = {}) => {
  const read = async (req, res, next, optional) => {
    res.set("Cache-Control", "no-store");
    try {
      const shopId = optional ? req.shopid : requestedShop(req);
      const session = await sessions.read({ rawToken: rawCustomerToken(req), shopId });
      req.customerSession = session;
      if (!session && !optional) return failed(res, "Customer session required", "CUSTOMER_SESSION_INVALID", 401);
      return next();
    } catch (_) { return failed(res, "Customer session unavailable", "CUSTOMER_SESSION_UNAVAILABLE", 503); }
  };
  const requireCustomerCsrf = (req, res, next) => {
    try {
      if (sessions.verifyCsrf({ session: req.customerSession, token: req.headers["x-csrf-token"], origin: req.headers.origin })) return next();
      return failed(res, "Customer CSRF refused", "CUSTOMER_CSRF_FORBIDDEN", 403);
    } catch (_) { return failed(res, "Customer session unavailable", "CUSTOMER_SESSION_UNAVAILABLE", 503); }
  };
  return {
    requireCustomerSession: (req, res, next) => read(req, res, next, false),
    attachOptionalCustomerSession: (req, res, next) => read(req, res, next, true),
    requireCustomerCsrf,
    requireCustomerCsrfIfPresent: (req, res, next) => req.customerSession ? requireCustomerCsrf(req, res, next) : next(),
  };
};

module.exports = { buildCustomerMiddleware, cookiePolicy, rawCustomerToken, setCustomerCookie, ...buildCustomerMiddleware() };
