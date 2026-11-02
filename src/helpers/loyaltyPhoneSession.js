const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const DomainError = require('./domainError');
const { authSecretReady } = require('../services/customerCodeTransports');
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const validShop = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const validCustomer = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const validMember = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const unavailable = () => new DomainError(503, 'LOYALTY_UNAVAILABLE', 'Loyalty session unavailable');
const cookiePolicy = (req, shopId) => {
  if (!validShop(shopId)) return null;
  if (req.secure) return { name: `__Host-smarteat_loyalty_${shopId}`, secure: true };
  return process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname)
    ? { name: `smarteat_loyalty_${shopId}`, secure: false } : null;
};
const rawLoyaltyPhoneToken = (req, shopId) => {
  const policy = cookiePolicy(req, shopId); return policy ? cookie.parse(req.headers.cookie || '')[policy.name] : undefined;
};
const setLoyaltyPhoneCookie = (req, res, issued) => {
  const policy = cookiePolicy(req, issued.session.shopId); if (!policy) throw unavailable();
  res.append('Set-Cookie', cookie.serialize(policy.name, issued.rawToken, { path: '/', httpOnly: true, secure: policy.secure,
    sameSite: 'lax', maxAge: SESSION_SECONDS, expires: new Date(issued.session.expiresAt) }));
};
const buildLoyaltyPhoneSession = ({ secret, allowedOrigins, clock = () => new Date() } = {}) => {
  const key = () => {
    const config = secret === undefined ? require('./env').getCustomerAuthConfig() : { secret };
    if (!authSecretReady({ secret: config.secret, jwtSecret: config.jwtSecret })) throw unavailable();
    return crypto.createHmac('sha256', config.secret).update('smarteat-loyalty-phone-session-v1').digest();
  };
  const csrfToken = session => crypto.createHmac('sha256', key()).update(JSON.stringify([
    'loyalty-csrf-v1', session.shopId, session.customerId, session.memberId, session.nonce, session.expiresAt,
  ])).digest('hex');
  const describe = session => ({ subject: 'loyalty', shopId: session.shopId, customerId: session.customerId,
    memberId: session.memberId, expiresAt: session.expiresAt, csrfToken: csrfToken(session) });
  const read = ({ rawToken, shopId }) => {
    if (!validShop(shopId) || typeof rawToken !== 'string' || rawToken.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(rawToken)) return null;
    const signingKey = key();
    try {
      const claims = jwt.verify(rawToken, signingKey, { algorithms: ['HS256'], issuer: 'smarteat-loyalty-phone', audience: 'loyalty', clockTimestamp: Math.floor(new Date(clock()).getTime() / 1000) });
      if (claims.subject_type !== 'loyalty' || claims.shopId !== shopId || !validCustomer(claims.customerId)
        || !validMember(claims.memberId) || !/^[a-f0-9]{64}$/.test(claims.nonce) || !Number.isSafeInteger(claims.exp)) return null;
      return { subject: 'loyalty', shopId, customerId: claims.customerId, memberId: claims.memberId,
        nonce: claims.nonce, expiresAt: new Date(claims.exp * 1000).toISOString() };
    } catch (_) { return null; }
  };
  return { read, describe,
    create({ shopId, customerId, memberId }) {
      if (!validShop(shopId) || !validCustomer(customerId) || !validMember(memberId)) throw unavailable();
      const iat = Math.floor(new Date(clock()).getTime() / 1000);
      const rawToken = jwt.sign({ subject_type: 'loyalty', shopId, customerId, memberId, nonce: crypto.randomBytes(32).toString('hex'), iat, exp: iat + SESSION_SECONDS },
        key(), { algorithm: 'HS256', issuer: 'smarteat-loyalty-phone', audience: 'loyalty' });
      return { rawToken, session: describe(read({ rawToken, shopId })) };
    },
    verifyCsrf({ session, token, origin }) {
      const origins = allowedOrigins === undefined ? require('./env').getCustomerSessionConfig().allowedOrigins : allowedOrigins;
      return !!session && new Date(session.expiresAt).getTime() > new Date(clock()).getTime() && origins.includes(origin)
        && typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
        && crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(csrfToken(session), 'hex'));
    },
  };
};
module.exports = { buildLoyaltyPhoneSession, rawLoyaltyPhoneToken, setLoyaltyPhoneCookie, cookiePolicy, SESSION_SECONDS };
