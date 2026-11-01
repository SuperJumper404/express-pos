const jwt = require('jsonwebtoken');
const buildLoyaltyTableContext = ({
  verifyToken = token => jwt.verify(token, require('../env').envJWTKEY),
  findServicePoint = input => require('../../modules/m_servicePoints').findServicePoint(input),
} = {}) => ({
  async read({ token, shopId }) {
    if (typeof token !== 'string' || !token || token.length > 4096) return null;
    let claims;
    try { claims = verifyToken(token); } catch (_) { return null; }
    if (!claims || claims.subject_type !== 'service_point' || claims.source !== 'table_qr'
      || Number(claims.shopid) !== Number(shopId) || !Number.isSafeInteger(claims.service_point_id) || claims.service_point_id < 1) return null;
    const point = await findServicePoint({ shopId: Number(shopId), servicePointId: claims.service_point_id });
    return point && Number(point.shopid) === Number(shopId) && point.type === 'table' && Number(point.is_active) === 1
      ? { shopId: Number(shopId), servicePointId: claims.service_point_id } : null;
  },
});
module.exports = { buildLoyaltyTableContext };
