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

test('restaurant notification icons publish atomically and survive partial artwork updates', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'smarteat-notification-icon-'));
  let current = null; const published = new Set();
  const repository = { current: async () => current,
    isPublished: async ({ shopId, assetVersion }) => shopId === 7 && published.has(assetVersion),
    publish: async ({ assetVersion }) => { current = assetVersion; published.add(assetVersion); } };
  const service = assets.buildLoyaltyWalletAssets({ rootPath: folder, repository });
  const icon = { icon: png(38, 38), icon2x: png(76, 76), icon3x: png(114, 114) };
  const logo = { logo: png(160, 50), logo2x: png(320, 100), logo3x: png(480, 150) };
  const strip = { strip: png(375, 144), strip2x: png(750, 288), strip3x: png(1125, 432) };
  try {
    await service.publish({ shopId: 7, files: { ...logo, ...strip } });
    const result = await service.publish({ shopId: 7, files: icon });
    assert.match(result.iconPreviewUrl, /\/icon\.png$/);
    let saved = await service.readAssets({ shopId: 7, assetVersion: result.assetVersion });
    assert.deepEqual(saved['icon@3x.png'], icon.icon3x);
    assert.deepEqual(saved['logo.png'], logo.logo); assert.deepEqual(saved['strip.png'], strip.strip);
    const later = await service.publish({ shopId: 7, files: strip });
    saved = await service.readAssets({ shopId: 7, assetVersion: later.assetVersion });
    assert.deepEqual(saved['icon.png'], icon.icon);
    await assert.rejects(service.readAssets({ shopId: 8, assetVersion: later.assetVersion }));
    for (const files of [{ icon: icon.icon }, { ...icon, icon2x: png(38, 38) }, { unknown: icon.icon }]) {
      await assert.rejects(service.publish({ shopId: 7, files })); assert.equal(current, later.assetVersion);
    }
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('icon upload and preview use the existing admin authority and multipart route', async () => {
  const express = require('express'); const http = require('http');
  const { buildLoyaltyAssetsController } = require('../src/controllers/c_loyaltyAssets');
  const uploads = [];
  const controller = buildLoyaltyAssetsController({ assets: {
    publish: async input => { uploads.push(input); return { assetVersion: 'published' }; },
    readAssets: async ({ shopId }) => { assert.equal(shopId, 7); return { 'icon.png': png(38, 38) }; },
  } });
  const app = express();
  app.use((req, res, next) => { req.sessionSubject = 'staff'; req.id = 2; req.shopid = 7;
    req.currentUser = { id: 2, shopid: 7, status: 1, access: req.headers['x-test-role'] === 'cashier' ? 1 : 0 }; next(); });
  app.post('/assets', controller.publish); app.get('/assets/:version/:name', controller.preview);
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = () => { const form = new FormData();
    for (const [group, width, height] of [['icon', 38, 38], ['logo', 160, 50], ['strip', 375, 144]])
      for (let scale = 1; scale <= 3; scale++) form.append(group + (scale === 1 ? '' : `${scale}x`), new Blob([png(width * scale, height * scale)]), 'image.png');
    return form; };
  try {
    let response = await fetch(`${base}/assets`, { method: 'POST', body: body(), headers: { 'x-test-role': 'cashier' } });
    assert.equal(response.status, 403); assert.equal(uploads.length, 0);
    response = await fetch(`${base}/assets`, { method: 'POST', body: body() });
    assert.equal(response.status, 200); assert.equal(Object.keys(uploads[0].files).length, 9);
    response = await fetch(`${base}/assets/version/icon.png`); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    response = await fetch(`${base}/assets/version/icon.png`, { headers: { 'x-test-role': 'cashier' } }); assert.equal(response.status, 403);
    response = await fetch(`${base}/assets/version/secret.png`); assert.equal(response.status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
