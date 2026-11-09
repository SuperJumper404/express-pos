const DomainError = require('../helpers/domainError');
const { custom, failed } = require('../helpers/response');
const { parseModulePermissions } = require('../helpers/staffPermissions');
const forbidden = () => new DomainError(403, 'CUSTOMER_PHONE_FORBIDDEN', 'Accès clients non autorisé.');
const invalid = () => new DomainError(422, 'CUSTOMER_PHONE_INVALID', 'Vérifiez les paramètres du téléphone.');
const buildCustomerPhoneController = ({ service = require('../modules/m_customerPhone').buildCustomerPhoneService(),
  tableContext = require('../helpers/middleware/loyaltyTableContext').buildLoyaltyTableContext(),
  access = require('../helpers/middleware/loyaltyAccess').buildLoyaltyAccess(), allowedOrigins } = {}) => ({
  async resolve(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      if (Object.keys(req.query || {}).length) throw invalid();
      const body = req.body || {};
      if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['phone', 'countryCode', 'name'].includes(key))) throw invalid();
      const shopId = Number(req.shopid), user = req.currentUser;
      if (!Number.isInteger(shopId) || shopId < 1 || shopId > 2147483647) throw forbidden();
      const staff = req.sessionSubject === 'staff';
      if (staff) {
        if (!user || user.access == null || ![0,1,4,5].includes(Number(user.access)) || Number(user.status) !== 1
          || String(user.id) !== String(req.id) || String(user.shopid) !== String(req.shopid)
          || (Number(user.access) !== 0 && !(parseModulePermissions(user.module_permissions, user.access) || []).some(key => ['orders', 'cashregister'].includes(key)))) throw forbidden();
        await access.lookupQuota({ shopId, actorKey: `staff:${req.id}`, audience: 'staff' });
      } else {
        if (req.sessionSubject !== 'service_point' || req.orderSource !== 'table_qr') throw forbidden();
        const origins = allowedOrigins === undefined ? require('../helpers/env').getCustomerSessionConfig().allowedOrigins : allowedOrigins;
        if (!origins.includes(req.headers?.origin)) throw forbidden();
        const token = /^Bearer (.+)$/i.exec(req.headers?.authorization || '')?.[1];
        const table = await tableContext.read({ shopId, token });
        if (!table || Number(table.servicePointId) !== Number(req.servicePointId)) throw forbidden();
        await access.lookupQuota({ shopId, actorKey: `phone-ip:${req.ip}`, audience: 'kiosk' });
        await access.lookupQuota({ shopId, actorKey: `phone-table:${table.servicePointId}`, audience: 'staff' });
      }
      const result = await service.resolve({ ...body, shopId });
      const data = staff ? result : { status: result.status, phone: result.phone, created: result.created, profilePresent: Boolean(result.customer), loyalty: result.loyalty ? { available: result.loyalty.available } : null };
      return custom(res, 200, 'OK', null, data);
    } catch (error) {
      return error instanceof DomainError ? failed(res, error.message, error.code, error.status) : failed(res, 'La fiche client est indisponible.', 'CUSTOMER_PHONE_UNAVAILABLE', 503);
    }
  },
});
module.exports = { buildCustomerPhoneController };
