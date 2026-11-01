const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
let assets = {};
try { assets = require('../src/services/loyaltyWalletAssets'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
function crc(bytes) { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function png(width, height) {
  const chunk = (name, bytes) => { const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(name, 4); bytes.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
test('wallet artwork validates actual PNG content, dimensions and complete variant groups', () => {
  assert.equal(typeof assets.validateWalletPng, 'function');
  const good = png(375, 144);
  assert.doesNotThrow(() => assets.validateWalletPng(good, { width: 375, height: 144 }));
  for (const bad of [Buffer.from('not png'), good.subarray(0, -1), png(1, 1), Buffer.from(good)]) {
    if (bad.length === good.length) bad[bad.length - 5] ^= 1;
    assert.throws(() => assets.validateWalletPng(bad, { width: 375, height: 144 }));
  }
});
test('artwork is published by version and a failed publication preserves the prior card artwork', async () => {
  assert.equal(typeof assets.buildLoyaltyWalletAssets, 'function');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'smarteat-artwork-test-'));
  let current = null; let fail = false;
  const published = new Set();
  const repository = { current: async () => current, isPublished: async ({ shopId, assetVersion }) => shopId === 7 && published.has(assetVersion),
    publish: async ({ shopId, assetVersion }) => { assert.equal(shopId, 7); if (fail) throw new Error('SQL failure'); current = assetVersion; published.add(assetVersion); } };
  const files = { strip: png(375, 144), strip2x: png(750, 288), strip3x: png(1125, 432) };
  try {
    const service = assets.buildLoyaltyWalletAssets({ rootPath: folder, repository });
    const first = await service.publish({ shopId: 7, files });
    assert.equal(current, first.assetVersion);
    const saved = await service.readAssets({ shopId: 7, assetVersion: first.assetVersion });
    assert.deepEqual(saved['strip@3x.png'], files.strip3x);
    await assert.rejects(service.readAssets({ shopId: 8, assetVersion: first.assetVersion }));
    await assert.rejects(service.readAssets({ shopId: 7, assetVersion: '../../outside' }));
    await assert.rejects(service.publish({ shopId: 7, files: { strip: files.strip } }));
    fail = true;
    await assert.rejects(service.publish({ shopId: 7, files }));
    assert.equal(current, first.assetVersion);
    assert.deepEqual((await service.readAssets({ shopId: 7, assetVersion: first.assetVersion }))['strip.png'], files.strip);
  } finally { assert(folder.startsWith(os.tmpdir())); await fs.rm(folder, { recursive: true, force: true }); }
});
