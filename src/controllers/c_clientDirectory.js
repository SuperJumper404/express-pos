const DomainError = require('../helpers/domainError');
const { custom, failed } = require('../helpers/response');
const { parseModulePermissions } = require('../helpers/staffPermissions');
const invalid = () => new DomainError(400, 'CLIENT_DIRECTORY_INVALID', 'Vérifiez les paramètres clients.');
const forbidden = () => new DomainError(403, 'CLIENT_DIRECTORY_FORBIDDEN', 'Accès clients non autorisé.');
const buildClientDirectoryController = ({ service = require('../modules/m_clientDirectory').buildClientDirectoryService() } = {}) => {
  const scope = (req, adminOnly = false) => {
    const user = req.currentUser;
    if (req.sessionSubject !== 'staff' || !user || !user.id || !user.shopid || user.access == null
      || ![0, 1, 4, 5].includes(Number(user.access)) || Number(user.status) !== 1
      || String(user.id) !== String(req.id) || String(user.shopid) !== String(req.shopid)) throw forbidden();
    const admin = Number(user.access) === 0;
    if (!admin && (adminOnly || !(parseModulePermissions(user.module_permissions, user.access) || []).includes('history'))) throw forbidden();
    return { shopId: Number(req.shopid), canManageLoyalty: admin, actorId: Number(req.id) };
  };
  const query = req => {
    const value = req.query || {};
    if (Object.keys(value).some(key => !['q', 'filter', 'page', 'pageSize', 'sortBy', 'sortDesc'].includes(key))) throw invalid();
    return value;
  };
  const body = (req, fields) => {
    const value = req.body || {};
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid();
    return value;
  };
  const endpoint = work => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { return await work(req, res); }
    catch (error) {
      if (error instanceof DomainError) return failed(res, error.message, error.code, error.status);
      return failed(res, 'Les clients sont indisponibles. Réessayez.', 'CLIENT_DIRECTORY_UNAVAILABLE', 503);
    }
  };
  const json = work => endpoint(async (req, res) => custom(res, 200, 'OK', null, await work(req)));
  return {
    list: json(req => service.list({ ...scope(req), ...query(req) })),
    detail: json(req => { const owned = scope(req); if (Object.keys(req.query || {}).length) throw invalid(); return service.detail({ ...owned, id: req.params.id }); }),
    exportCsv: endpoint(async (req, res) => {
      const csv = await service.exportCsv({ ...scope(req), ...query(req) });
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="clients-fidelite.csv"');
      return res.send(`\uFEFF${csv}`);
    }),
    reconcile: json(req => { const owned = scope(req, true); if (Object.keys(req.query || {}).length) throw invalid(); return service.reconcile({ ...owned, ...body(req, ['dryRun']) }); }),
    linkContact: json(req => { const owned = scope(req, true); if (Object.keys(req.query || {}).length) throw invalid(); return service.linkContact({ ...owned, contactKey: req.params.contactKey, ...body(req, ['customerId']) }); }),
  };
};
module.exports = { buildClientDirectoryController };
