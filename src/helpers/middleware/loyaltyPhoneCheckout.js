const { failed } = require('../response');
const { buildLoyaltyPhoneSession, rawLoyaltyPhoneToken } = require('../loyaltyPhoneSession');
const buildLoyaltyPhoneCheckout = ({ sessions = buildLoyaltyPhoneSession(),
  attachOptionalCustomerSession = (...args) => require('./customerAuth').attachOptionalCustomerSession(...args) } = {}) => async (req, res, next) => {
  if (req.body && req.body.loyalty_phone !== undefined && typeof req.body.loyalty_phone !== 'boolean') return failed(res, 'Invalid loyalty request', 'LOYALTY_INVALID', 422);
  if (!req.body || req.body.loyalty_phone !== true) return attachOptionalCustomerSession(req, res, next);
  if (req.sessionSubject !== 'service_point' || req.orderSource !== 'table_qr' || req.body.fulfillment_type === 'delivery') return failed(res, 'Table loyalty required', 'LOYALTY_FORBIDDEN', 403);
  try {
    const shopId = Number(req.shopid);
    const session = sessions.read({ rawToken: rawLoyaltyPhoneToken(req, shopId), shopId });
    if (!session) return failed(res, 'Loyalty session required', 'LOYALTY_SESSION_INVALID', 401);
    if (!sessions.verifyCsrf({ session, token: req.headers['x-csrf-token'], origin: req.headers.origin })) return failed(res, 'Loyalty CSRF refused', 'LOYALTY_CSRF_FORBIDDEN', 403);
    req.customerSession = null;
    req.loyaltyCustomerContext = { shopId, customerId: session.customerId, memberId: session.memberId };
    return next();
  } catch (_) { return failed(res, 'Loyalty unavailable', 'LOYALTY_UNAVAILABLE', 503); }
};
module.exports = { buildLoyaltyPhoneCheckout };
