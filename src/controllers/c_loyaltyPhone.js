const DomainError = require('../helpers/domainError');
const { invalid } = require('../helpers/loyalty');
const { custom, failed } = require('../helpers/response');
const { buildLoyaltyPhoneSession, rawLoyaltyPhoneToken, setLoyaltyPhoneCookie } = require('../helpers/loyaltyPhoneSession');
const shopFor = req => {
  const query = req.query || {};
  if (Object.keys(query).some(key => key !== 'shopId') || typeof query.shopId !== 'string' || !/^[1-9]\d{0,9}$/.test(query.shopId) || Number(query.shopId) > 2147483647) throw invalid();
  return Number(query.shopId);
};
const fields = (req, allowed) => {
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw invalid(); return body;
};
const denied = code => new DomainError(code === 'LOYALTY_SESSION_INVALID' ? 401 : 403, code, 'Loyalty access refused');
const buildLoyaltyPhoneController = ({ loyalty = require('../modules/m_loyalty').buildLoyalty(), sessions = buildLoyaltyPhoneSession(),
  tableContext = require('../helpers/middleware/loyaltyTableContext').buildLoyaltyTableContext(),
  access = require('../helpers/middleware/loyaltyAccess').buildLoyaltyAccess(), wallet, allowedOrigins } = {}) => {
  const originAllowed = req => (allowedOrigins === undefined ? require('../helpers/env').getCustomerSessionConfig().allowedOrigins : allowedOrigins).includes(req.headers.origin);
  const sessionFor = (req, shopId) => sessions.read({ rawToken: rawLoyaltyPhoneToken(req, shopId), shopId });
  const memberFor = async (shopId, session) => {
    if (!session) throw denied('LOYALTY_SESSION_INVALID');
    const member = await loyalty.getMember({ shopId, customerId: session.customerId });
    if (member.id !== session.memberId) throw denied('LOYALTY_SESSION_INVALID'); return member;
  };
  const mutateSession = (req, shopId) => {
    const session = sessionFor(req, shopId);
    if (!session) throw denied('LOYALTY_SESSION_INVALID');
    if (!sessions.verifyCsrf({ session, token: req.headers['x-csrf-token'], origin: req.headers.origin })) throw denied('LOYALTY_CSRF_FORBIDDEN');
    return session;
  };
  const endpoint = work => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return custom(res, 200, 'OK', null, await work(req, res, shopFor(req))); }
    catch (error) { return error instanceof DomainError ? failed(res, error.message, error.code, error.status) : failed(res, 'Loyalty unavailable', 'LOYALTY_UNAVAILABLE', 503); }
  };
  return {
    read: endpoint(async (req, res, shopId) => {
      const session = sessionFor(req, shopId);
      const member = session ? await memberFor(shopId, session) : null;
      return { member, program: member ? member.program : await loyalty.getProgram({ shopId }), session: session ? sessions.describe(session) : null,
        canEnroll: !!await tableContext.read({ shopId, token: req.headers['x-table-session'] }) };
    }),
    enroll: endpoint(async (req, res, shopId) => {
      if (!originAllowed(req)) throw denied('LOYALTY_FORBIDDEN');
      const body = fields(req, ['phone', 'countryCode', 'marketingConsent']);
      const table = await tableContext.read({ shopId, token: req.headers['x-table-session'] });
      if (!table) throw denied('LOYALTY_TABLE_REQUIRED');
      await access.lookupQuota({ shopId, actorKey: `phone-ip:${req.ip}`, audience: 'kiosk' });
      await access.lookupQuota({ shopId, actorKey: `phone-table:${table.servicePointId}`, audience: 'staff' });
      const { member, customerId } = await loyalty.enrollPhone({ shopId, ...body });
      const issued = sessions.create({ shopId, customerId, memberId: member.id });
      setLoyaltyPhoneCookie(req, res, issued);
      return { member, program: member.program, session: issued.session, canEnroll: true };
    }),
    preferences: endpoint(async (req, res, shopId) => {
      const session = mutateSession(req, shopId); const { marketingConsent } = fields(req, ['marketingConsent']);
      if (typeof marketingConsent !== 'boolean') throw invalid();
      await memberFor(shopId, session);
      const member = await loyalty.setMarketingConsent({ shopId, customerId: session.customerId, marketingConsent });
      return { member, program: member.program, session: sessions.describe(session), canEnroll: false };
    }),
    wallet: endpoint(async (req, res, shopId) => {
      const session = mutateSession(req, shopId); fields(req, []);
      const provider = req.params.provider; if (!['apple', 'google'].includes(provider)) throw invalid();
      const member = await memberFor(shopId, session);
      return (wallet || require('../services/loyaltyWallet').buildLoyaltyWallet()).issueWallet({ shopId, provider, member, program: member.program });
    }),
  };
};
module.exports = { buildLoyaltyPhoneController };
