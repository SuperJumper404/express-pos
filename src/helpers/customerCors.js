const cookie = require("cookie");
const net = require("net");
const { failed } = require("./response");

const cookies = req => cookie.parse(req.headers.cookie || "");
const hasCustomerCookie = req => {
  const parsed = cookies(req);
  return Object.prototype.hasOwnProperty.call(parsed, "__Host-smarteat_customer") || Object.prototype.hasOwnProperty.call(parsed, "smarteat_customer");
};
const relativePath = (req, prefix) => {
  const path = (req.originalUrl || req.url || "/").split("?")[0];
  return path.toLowerCase().startsWith(prefix.toLowerCase() + "/") ? path.slice(prefix.length) : path;
};
const isPersonalPath = path => /^\/(customer-auth|customer)(\/|$)/i.test(path);
const isCustomerCorsRequest = (req, prefix = require("../config/prefix")) => {
  const path = relativePath(req, prefix);
  return isPersonalPath(path) || (/^\/orders\/checkout\/?$/i.test(path) &&
    (hasCustomerCookie(req) || /(?:^|,)\s*x-csrf-token\s*(?:,|$)/i.test(req.headers["access-control-request-headers"] || "")));
};
const buildCustomerCors = ({ prefix = require("../config/prefix"), allowedOrigins } = {}) => (req, res, next) => {
  if (!isCustomerCorsRequest(req, prefix)) return next();
  res.vary("Origin");
  const origins = allowedOrigins === undefined ? require("./env").getCustomerSessionConfig().allowedOrigins : allowedOrigins;
  const origin = req.headers.origin;
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if ((origin && !origins.includes(origin)) || (!origin && (mutation || req.method === "OPTIONS"))) {
    return failed(res, "Customer origin refused", "CUSTOMER_ORIGIN_FORBIDDEN", 403);
  }
  if (origin) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.vary("Access-Control-Request-Method");
    res.vary("Access-Control-Request-Headers");
    const headers = (req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
    if (!["GET", "HEAD", "POST", "PATCH", "DELETE"].includes(req.headers["access-control-request-method"])
      || headers.some(value => !["content-type", "x-csrf-token", "authorization", "authentication", "accept"].includes(value))) {
      return failed(res, "Customer preflight refused", "CUSTOMER_ORIGIN_FORBIDDEN", 403);
    }
    res.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, Authorization, Authentication, Accept");
    return res.status(204).end();
  }
  return next();
};

const configureCustomerTrustProxy = (app, trustedProxies = require("./env").getCustomerSessionConfig().trustedProxies) => {
  // Only literal IPs/CIDRs, never hop counts, blanket trust, or arbitrary XFF.
  const valid = trustedProxies.every(value => {
    const [address, bits, ...rest] = value.split("/");
    const family = net.isIP(address);
    return family && !rest.length && (bits === undefined || (/^\d+$/.test(bits) && Number(bits) <= (family === 4 ? 32 : 128)));
  });
  app.set("trust proxy", valid && trustedProxies.length ? trustedProxies : false);
};

module.exports = { buildCustomerCors, configureCustomerTrustProxy, isCustomerCorsRequest, hasCustomerCookie, isPersonalPath, relativePath };
