const multer = require('multer');
const { staffScope } = require('./c_loyalty');
const { custom, failed } = require('../helpers/response');
const { buildLoyaltyWalletAssets } = require('../services/loyaltyWalletAssets');
const fields = ['logo', 'logo2x', 'logo3x', 'strip', 'strip2x', 'strip3x'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 6, fields: 0 } }).fields(fields.map(name => ({ name, maxCount: 1 })));
const buildLoyaltyAssetsController = ({ assets = buildLoyaltyWalletAssets() } = {}) => ({
  publish(req, res) {
    res.set('Cache-Control', 'no-store');
    try { staffScope(req, true); } catch (error) { return failed(res, 'Access denied', 'LOYALTY_FORBIDDEN', 403); }
    return upload(req, res, async error => {
      if (error) return failed(res, 'Invalid image upload', 'LOYALTY_IMAGE_INVALID', 422);
      try {
        const files = Object.fromEntries(Object.entries(req.files || {}).map(([name, values]) => [name, values[0].buffer]));
        return custom(res, 200, 'OK', null, await assets.publish({ ...staffScope(req, true), files }));
      } catch (failure) { return failed(res, 'Unable to publish Wallet artwork', failure.code || 'LOYALTY_UNAVAILABLE', failure.status || 503); }
    });
  },
  async preview(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
      const scope = staffScope(req, true);
      if (!/^(?:logo|strip)(?:@2x|@3x)?\.png$/.test(req.params.name)) return res.sendStatus(404);
      const files = await assets.readAssets({ ...scope, assetVersion: req.params.version });
      if (!files[req.params.name]) return res.sendStatus(404);
      return res.type('image/png').send(files[req.params.name]);
    } catch (failure) { return failed(res, 'Unable to read Wallet artwork', failure.code || 'LOYALTY_UNAVAILABLE', failure.status || 503); }
  },
});
module.exports = { buildLoyaltyAssetsController };
