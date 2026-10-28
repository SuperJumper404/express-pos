const DomainError = require('../helpers/domainError');
const { invalid } = require('../helpers/loyalty');
const { custom, failed } = require('../helpers/response');
const { parseModulePermissions } = require('../helpers/staffPermissions');

const fields = (req, allowed) => {
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw invalid();
  return body;
};
const staffScope = (req, admin) => {
  const user = req.currentUser;
  if (req.sessionSubject !== 'staff' || !user || user.access == null || Number(user.status) !== 1 || String(user.id) !== String(req.id)
    || String(user.shopid) !== String(req.shopid) || !(Number(user.access) === 0 || (!admin && Number(user.access) === 1 &&
      (parseModulePermissions(user.module_permissions, user.access) || []).includes('cashregister')))) {
    throw new DomainError(403, 'LOYALTY_FORBIDDEN', 'Loyalty access denied');
  }
  return { shopId: req.shopid };
};
const personalScope = req => {
  const session = req.customerSession;
  if (!session || !session.shopId || !session.customerId) throw new DomainError(401, 'CUSTOMER_SESSION_INVALID', 'Customer session required');
  return { shopId: session.shopId, customerId: session.customerId };
};
const buildLoyaltyController = ({ loyalty = require('../modules/m_loyalty').buildLoyalty(), wallet } = {}) => {
  const endpoint = (work, personal = false) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (Object.keys(req.query || {}).some(key => !personal || key !== 'shopId')) throw invalid();
      if (personal && req.query && req.query.shopId !== undefined && String(req.query.shopId) !== String(personalScope(req).shopId)) throw invalid();
      return custom(res, 200, 'OK', null, await work(req));
    } catch (error) {
      if (error instanceof DomainError) return failed(res, error.message, error.code, error.status);
      return failed(res, 'Loyalty service unavailable', 'LOYALTY_UNAVAILABLE', 503);
    }
  };
  return {
    getProgram: endpoint(req => loyalty.getProgram(staffScope(req, true))),
    saveProgram: endpoint(req => {
      const scope = staffScope(req, true);
      const program = fields(req, ['enabled', 'name', 'pointsPerEuro', 'rounding', 'includeTips', 'excludedProductIds', 'rewards', 'logoUrl', 'backgroundColor', 'foregroundColor']);
      return loyalty.saveProgram({ ...scope, program });
    }),
    listMembers: endpoint(req => loyalty.listMembers(staffScope(req, true))),
    getStaffMember: endpoint(req => loyalty.getMember({ ...staffScope(req, true), memberId: req.params.memberId })),
    lookup: endpoint(req => loyalty.lookup({ ...staffScope(req, false), ...fields(req, ['qr']) })),
    adjust: endpoint(req => loyalty.adjust({ ...staffScope(req, true), memberId: req.params.memberId,
      ...fields(req, ['points', 'reason']), actorId: req.id })),
    attach: endpoint(req => loyalty.attach({ ...staffScope(req, false), orderId: req.params.orderId, ...fields(req, ['qr']) })),
    reserve: endpoint(req => loyalty.reserve({ ...staffScope(req, false), orderId: req.params.orderId, ...fields(req, ['rewardId', 'confirmed']) })),
    release: endpoint(req => { const scope = staffScope(req, false); fields(req, []); return loyalty.release({ ...scope, orderId: req.params.orderId }); }),
    getPersonal: endpoint(req => loyalty.getMember(personalScope(req)), true),
    enroll: endpoint(req => { const scope = personalScope(req); fields(req, []); return loyalty.enroll(scope); }, true),
    wallet: endpoint(async req => {
      const scope = personalScope(req); fields(req, []);
      const provider = req.params.provider;
      if (!['apple', 'google'].includes(provider)) throw invalid();
      const member = await loyalty.getMember(scope);
      if (!member.id) throw new DomainError(404, 'LOYALTY_NOT_FOUND', 'Join loyalty before adding a card');
      return (wallet || require('../services/loyaltyWallet').buildLoyaltyWallet()).issueWallet({ provider, program: member.program, member, shopId: scope.shopId });
    }, true),
  };
};
module.exports = { buildLoyaltyController, staffScope, personalScope };
