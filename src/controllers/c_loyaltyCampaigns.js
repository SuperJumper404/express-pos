const { staffScope } = require('./c_loyalty');
const { custom, failed } = require('../helpers/response');
const { invalid } = require('../helpers/loyalty');
const buildLoyaltyCampaignsController = ({ campaigns = require('../modules/m_loyaltyCampaigns').buildLoyaltyCampaigns() } = {}) => {
  const endpoint = (work, queries = []) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const scope = staffScope(req, true);
      if (Object.keys(req.query || {}).some(key => !queries.includes(key))) throw invalid();
      return custom(res, 200, 'OK', null, await work(req, scope));
    } catch (error) { if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds)); return failed(res, 'Unable to process Wallet campaign', error.code || 'LOYALTY_UNAVAILABLE', error.status || 503); }
  };
  const body = (req, allowed) => { const value = req.body || {}; if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid(); return value; };
  return {
    create: endpoint((req, scope) => campaigns.createDraft({ ...scope, actorId: Number(req.id), ...body(req, ['requestId', 'message', 'target']) })),
    send: endpoint((req, scope) => campaigns.send({ ...scope, campaignId: req.params.id, ...body(req, ['confirmed']) })),
    list: endpoint((req, scope) => campaigns.list({ ...scope, page: req.query.page === undefined ? 1 : Number(req.query.page), pageSize: req.query.pageSize === undefined ? 25 : Number(req.query.pageSize) }), ['page', 'pageSize']),
  };
};
module.exports = { buildLoyaltyCampaignsController };
