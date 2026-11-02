const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { inflateSync } = require('zlib');
const DomainError = require('../helpers/domainError');
const { normalizeProgram } = require('../helpers/loyalty');
const invalid = () => new DomainError(422, 'LOYALTY_IMAGE_INVALID', 'Use complete PNG artwork variants in the expected dimensions');
const names = { icon: ['icon.png', 38, 38], icon2x: ['icon@2x.png', 76, 76], icon3x: ['icon@3x.png', 114, 114],
  logo: ['logo.png', 160, 50], logo2x: ['logo@2x.png', 320, 100], logo3x: ['logo@3x.png', 480, 150],
  strip: ['strip.png', 375, 144], strip2x: ['strip@2x.png', 750, 288], strip3x: ['strip@3x.png', 1125, 432] };
const versionValid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; };
function validateWalletPng(bytes, { width, height }) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > 2 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw invalid();
  let offset = 8; let channels; let ended = false; const data = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + length + 12;
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw invalid();
    const chunk = bytes.subarray(offset + 8, end - 4);
    if (offset === 8 && type !== 'IHDR') throw invalid();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13 || chunk.readUInt32BE(0) !== width || chunk.readUInt32BE(4) !== height
        || chunk[8] !== 8 || ![2, 6].includes(chunk[9]) || chunk[10] || chunk[11] || chunk[12]) throw invalid();
      channels = chunk[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') data.push(chunk);
    else if (type === 'IEND') { if (length || end !== bytes.length) throw invalid(); ended = true; }
    else if (type[0] === type[0].toUpperCase() && type !== 'PLTE') throw invalid();
    offset = end;
    if (ended) break;
  }
  if (!ended || !data.length || !channels) throw invalid();
  const rowSize = width * channels + 1; let pixels;
  try { pixels = inflateSync(Buffer.concat(data), { maxOutputLength: rowSize * height }); } catch (_) { throw invalid(); }
  if (pixels.length !== rowSize * height) throw invalid();
  for (let y = 0; y < height; y++) if (pixels[y * rowSize] > 4) throw invalid();
}
const buildSqlAssetsRepository = () => {
  const pool = () => require('../config/dbPool');
  return {
    async current({ shopId }) { const [[row]] = await pool().query('SELECT wallet_asset_version FROM loyalty_programs WHERE shopid=?', [shopId]); return row && row.wallet_asset_version; },
    async isPublished({ shopId, assetVersion }) { const [[row]] = await pool().query('SELECT version FROM loyalty_wallet_assets WHERE shopid=? AND version=?', [shopId, assetVersion]); return !!row; },
    async publish({ shopId, assetVersion }) {
      const connection = await pool().getConnection();
      try {
        await connection.beginTransaction();
        await connection.query('SELECT id FROM shop WHERE id=? FOR UPDATE', [shopId]);
        await connection.query('INSERT INTO loyalty_wallet_assets (version,shopid) VALUES (?,?)', [assetVersion, shopId]);
        await connection.query(`INSERT INTO loyalty_programs (shopid,config,wallet_asset_version) VALUES (?,?,?)
          ON DUPLICATE KEY UPDATE wallet_asset_version=VALUES(wallet_asset_version),version=version+1`, [shopId, JSON.stringify(normalizeProgram()), assetVersion]);
        await connection.query('UPDATE loyalty_members SET revision=revision+1 WHERE shopid=?', [shopId]);
        await connection.query(`INSERT IGNORE INTO loyalty_wallet_jobs (shopid,member_id,revision,next_attempt_at,created_at)
          SELECT shopid,id,revision,UTC_TIMESTAMP(),UTC_TIMESTAMP() FROM loyalty_members WHERE shopid=?`, [shopId]);
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
    },
  };
};
const buildLoyaltyWalletAssets = ({ rootPath = process.env.APPLE_WALLET_ASSETS_PATH, repository = buildSqlAssetsRepository() } = {}) => {
  const folder = (shopId, assetVersion) => {
    if (!rootPath) throw new DomainError(503, 'LOYALTY_WALLET_NOT_CONFIGURED', 'Wallet artwork storage is not configured');
    if (!Number.isSafeInteger(Number(shopId)) || Number(shopId) < 1 || !versionValid(assetVersion)) throw invalid();
    const root = path.resolve(rootPath); const target = path.resolve(root, String(shopId), assetVersion);
    if (!target.startsWith(root + path.sep)) throw invalid();
    return target;
  };
  const readAssets = async ({ shopId, assetVersion }) => {
    const directory = folder(shopId, assetVersion);
    if (!await repository.isPublished({ shopId, assetVersion })) throw new DomainError(404, 'LOYALTY_NOT_FOUND', 'Artwork not found');
    const files = {};
    for (const [name] of Object.values(names)) {
      try { files[name] = await fs.readFile(path.join(directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return files;
  };
  return { readAssets, async publish({ shopId, files }) {
    if (!files || !Object.keys(files).length || Object.keys(files).some(name => !names[name])) throw invalid();
    for (const group of ['icon', 'logo', 'strip']) {
      const present = [group, `${group}2x`, `${group}3x`].filter(name => files[name]);
      if (present.length && present.length !== 3) throw invalid();
    }
    for (const [key, bytes] of Object.entries(files)) validateWalletPng(bytes, { width: names[key][1], height: names[key][2] });
    const previous = await repository.current({ shopId });
    const combined = previous ? await readAssets({ shopId, assetVersion: previous }) : {};
    for (const [key, bytes] of Object.entries(files)) combined[names[key][0]] = bytes;
    const assetVersion = randomUUID(); const directory = folder(shopId, assetVersion);
    await fs.mkdir(directory, { recursive: true });
    await Promise.all(Object.entries(combined).map(([name, bytes]) => fs.writeFile(path.join(directory, name), bytes, { flag: 'wx' })));
    // Keep an unreferenced directory on an uncertain SQL commit: never remove potentially published images.
    await repository.publish({ shopId, assetVersion });
    const preview = name => `/baseurl/api/v1/loyalty/wallet/assets/${assetVersion}/${name}`;
    return { assetVersion, iconPreviewUrl: combined['icon.png'] ? preview('icon.png') : null,
      logoPreviewUrl: combined['logo.png'] ? preview('logo.png') : null, stripPreviewUrl: combined['strip.png'] ? preview('strip.png') : null };
  } };
};
module.exports = { buildLoyaltyWalletAssets, validateWalletPng, buildSqlAssetsRepository };
