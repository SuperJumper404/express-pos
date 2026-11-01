const { createHash } = require('crypto');
const DomainError = require('../domainError');
const { parseModulePermissions } = require('../staffPermissions');
const forbidden = () => new DomainError(403, 'LOYALTY_FORBIDDEN', 'Loyalty access denied');
const consumeSqlQuota = async ({ shopId, actorKey }) => {
  const pool = require('../../config/dbPool');
  const key = createHash('sha256').update(actorKey).digest('hex');
  await pool.query(`INSERT INTO loyalty_lookup_limits (shopid,actor_key,window_start,attempts) VALUES (?,?,UTC_TIMESTAMP(3),1)
    ON DUPLICATE KEY UPDATE attempts=IF(window_start<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 60 SECOND),1,LEAST(attempts+1,1000000)),
    window_start=IF(window_start<=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 60 SECOND),UTC_TIMESTAMP(3),window_start)`, [shopId, key]);
  const [[row]] = await pool.query('SELECT attempts FROM loyalty_lookup_limits WHERE shopid=? AND actor_key=?', [shopId, key]);
  return Number(row.attempts);
};
const buildLoyaltyAccess = ({ findServicePoint = input => require('../../modules/m_servicePoints').findServicePoint(input), consumeQuota = consumeSqlQuota } = {}) => ({
  async kioskScope(req) {
    const user = req.currentUser;
    const device = req.sessionSubject === 'service_point' && req.orderSource === 'borne';
    const staff = req.sessionSubject === 'staff' && user && user.access != null && Number(user.status) === 1
      && String(user.id) === String(req.id) && String(user.shopid) === String(req.shopid)
      && (Number(user.access) === 0 || (parseModulePermissions(user.module_permissions, user.access) || []).includes('borne'));
    const servicePointId = device ? Number(req.servicePointId) : Number(req.body && req.body.servicePointId);
    if ((!device && !staff) || !Number.isSafeInteger(servicePointId) || servicePointId < 1) throw forbidden();
    const point = await findServicePoint({ shopId: Number(req.shopid), servicePointId });
    if (!point || Number(point.shopid) !== Number(req.shopid) || point.type !== 'kiosk' || Number(point.is_active) !== 1) throw forbidden();
    return { shopId: Number(req.shopid), servicePointId };
  },
  async lookupQuota({ shopId, actorKey, audience }) {
    const count = await consumeQuota({ shopId, actorKey });
    if (count > (audience === 'kiosk' ? 30 : 60)) throw new DomainError(429, 'LOYALTY_RATE_LIMITED', 'Too many loyalty searches. Try again shortly.');
  },
});
module.exports = { buildLoyaltyAccess };
