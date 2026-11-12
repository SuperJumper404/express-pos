const assert = require('assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { buildLoyaltyWallet } = require('../src/services/loyaltyWallet');
const run = promisify(execFile);
const entries = bytes => {
  const result = {}; let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 18); const nameLength = bytes.readUInt16LE(offset + 26); const extra = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extra;
    result[bytes.subarray(offset + 30, offset + 30 + nameLength).toString()] = bytes.subarray(start, start + size);
    offset = start + size;
  }
  return result;
};

(async () => {
  const candidates = [process.env.LOYALTY_OPENSSL_PATH, 'openssl', 'C:/Program Files/Git/usr/bin/openssl.exe'].filter(Boolean);
  let openssl;
  for (const candidate of candidates) { try { await run(candidate, ['version'], { windowsHide: true }); openssl = candidate; break; } catch (_) { /* try next */ } }
  if (!openssl) throw new Error('OpenSSL is required to verify pass signing');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'SmartEat signing test '));
  try {
    const key = path.join(folder, 'key.pem'); const cert = path.join(folder, 'cert.pem');
    await run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=SmartEat Local Test'], { windowsHide: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7xQAAAAASUVORK5CYII=', 'base64');
    await Promise.all(['icon.png', 'icon@2x.png', 'strip.png', 'strip@2x.png', 'strip@3x.png'].map(name => fs.writeFile(path.join(folder, name), png)));
    const config = { mode: 'development', offersBaseUrl: 'https://example.test', applePassTypeId: 'pass.test.smarteat', appleTeamId: 'TESTTEAM',
      appleCertificatePath: cert, appleKeyPath: key, appleWwdrPath: cert, appleAssetsPath: folder, appleWebServiceUrl: 'https://example.test/api/v1/wallet/apple', opensslPath: openssl };
    const pass = { serial: 'local-test-serial', auth_token: 'b'.repeat(64) };
    const service = buildLoyaltyWallet({ getConfig: () => config, repository: { ensurePass: async () => pass } });
    const input = { provider: 'apple', shopId: 7, program: { name: 'Local Test', enabled: true, rewards: [] }, member: { id: 'm', cardNumber: '0001234567890123', qr: 'a'.repeat(64), balance: 120 } };
    const first = await service.issueWallet(input); const second = await service.issueWallet({ ...input, member: { ...input.member, balance: 200 } });
    assert.equal(first.mode, 'development');
    const files = entries(Buffer.from(first.passBase64, 'base64'));
    const json = JSON.parse(files['pass.json']); const updated = JSON.parse(entries(Buffer.from(second.passBase64, 'base64'))['pass.json']);
    assert.equal(json.serialNumber, updated.serialNumber); assert.equal(json.authenticationToken, updated.authenticationToken);
    const named = JSON.parse(entries(Buffer.from((await service.issueWallet({ ...input, shopName: 'Le Bistrot', program: { ...input.program, name: 'Club gourmand' },
      member: { ...input.member, marketingConsent: true, walletMessage: 'Nouvelle offre\nUn dessert offert.' } })).passBase64, 'base64'))['pass.json']);
    assert.equal(named.organizationName, 'Le Bistrot'); assert.match(named.logoText, /Club gourmand/);
    assert.equal(named.storeCard.backFields.find(field => field.key === 'message').value, 'Nouvelle offre\nUn dessert offert.');
    assert.equal(updated.storeCard.headerFields[0].value, 200); assert.match(json.logoText, /TEST/);
    assert.equal(json.storeCard.headerFields[0].key, 'points');
    assert.equal(json.storeCard.headerFields[0].changeMessage, 'Votre solde est de %@ points.');
    assert.equal((json.storeCard.primaryFields || []).length, 0, 'native points must not overlap the graphic strip');
    assert.equal((json.storeCard.auxiliaryFields || []).length, 0, 'reward is the only information row above the QR');
    assert.equal(json.storeCard.secondaryFields[0].label, 'RÉCOMPENSE');
    assert.equal(JSON.stringify(json).includes('PROCHAIN PALIER'), false);
    assert(files['strip@3x.png']); assert.equal(json.barcodes[0].altText, '0001234567890123');
    assert.equal(json.storeCard.backFields.find(field => field.key === 'message').value, '');
    const fresh = buildLoyaltyWallet({ getConfig: () => config, repository: { ensurePass: async () => pass,
      readMember: async () => ({ ...input, member: { ...input.member, balance: 333, marketing_consent: 1, wallet_message: 'Offre du jour' } }) } });
    const freshJson = JSON.parse(entries(Buffer.from((await fresh.issueWallet(input)).passBase64, 'base64'))['pass.json']);
    assert.equal(freshJson.storeCard.headerFields[0].value, 333);
    assert.equal(freshJson.storeCard.backFields.find(field => field.key === 'message').value, 'Offre du jour');
    assert.equal(json.barcodes[0].message, input.member.qr); assert.ok(!json.storeCard.backFields[0].value.includes('auth'));
    const manifest = JSON.parse(files['manifest.json']);
    for (const name of Object.keys(manifest)) assert.equal(require('crypto').createHash('sha1').update(files[name]).digest('hex'), manifest[name]);
    await fs.writeFile(path.join(folder, 'signature'), files.signature); await fs.writeFile(path.join(folder, 'manifest.json'), files['manifest.json']);
    const verified = await run(openssl, ['smime', '-verify', '-inform', 'DER', '-in', path.join(folder, 'signature'), '-content', path.join(folder, 'manifest.json'), '-noverify'], { windowsHide: true, encoding: 'buffer' });
    assert.deepEqual(verified.stdout, files['manifest.json']);
    const { PNG } = require('pngjs');
    const progressFolder = path.join(folder, 'progress'); await fs.mkdir(progressFolder);
    await Promise.all(['icon.png', 'icon@2x.png'].map(name => fs.writeFile(path.join(progressFolder, name), png)));
    const pixels = Buffer.alloc(375 * 144 * 4);
    for (let index = 0; index < pixels.length; index += 4) pixels.set([10, 20, 30, 255], index);
    const originalBanner = PNG.sync.write({ width: 375, height: 144, data: pixels });
    await fs.writeFile(path.join(progressFolder, 'strip.png'), originalBanner);
    const progressService = buildLoyaltyWallet({ getConfig: () => ({ ...config, appleAssetsPath: progressFolder }), repository: { ensurePass: async () => pass } });
    const progressFiles = entries(Buffer.from((await progressService.issueWallet({ ...input,
      member: { ...input.member, balance: 20 }, program: { ...input.program, rewards: [{ id: 'dessert', name: 'Dessert offert', points: 30 }] } })).passBase64, 'base64'));
    const progressPass = JSON.parse(progressFiles['pass.json']);
    assert.equal(progressPass.serialNumber, json.serialNumber); assert.equal(progressPass.authenticationToken, json.authenticationToken);
    assert.equal(progressPass.storeCard.headerFields[0].value, 20);
    assert.equal(progressPass.storeCard.secondaryFields[0].value, 'Dessert offert — 20 / 30 points');
    assert.equal(progressPass.barcodes[0].altText, '0001234567890123'); assert.equal(progressPass.barcodes[0].message, input.member.qr);
    for (const scale of [1, 2, 3]) {
      const image = PNG.sync.read(progressFiles[`strip${scale === 1 ? '' : `@${scale}x`}.png`]);
      assert.equal(image.width, 375 * scale); assert.equal(image.height, 144 * scale);
      assert.deepEqual([...image.data.subarray(0, 4)], [10, 20, 30, 255]);
    }
    assert.deepEqual(await fs.readFile(path.join(progressFolder, 'strip.png')), originalBanner);
    const progressManifest = JSON.parse(progressFiles['manifest.json']);
    for (const name of Object.keys(progressManifest)) assert.equal(require('crypto').createHash('sha1').update(progressFiles[name]).digest('hex'), progressManifest[name]);
    await fs.writeFile(path.join(folder, 'signature'), progressFiles.signature); await fs.writeFile(path.join(folder, 'manifest.json'), progressFiles['manifest.json']);
    assert.deepEqual((await run(openssl, ['smime', '-verify', '-inform', 'DER', '-in', path.join(folder, 'signature'), '-content', path.join(folder, 'manifest.json'), '-noverify'], { windowsHide: true, encoding: 'buffer' })).stdout, progressFiles['manifest.json']);
    const assetVersion = '00000000-0000-4000-8000-000000000007';
    const artworkFolder = path.join(folder, '7', assetVersion); await fs.mkdir(artworkFolder, { recursive: true });
    // A valid PNG with a different ancillary text chunk distinguishes published artwork from the fallback.
    const text = Buffer.from('tEXtRestaurant\0notification icon');
    let crc = 0xffffffff; for (const byte of text) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const chunk = Buffer.alloc(text.length + 8); chunk.writeUInt32BE(text.length - 4); text.copy(chunk, 4); chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
    const customIcon = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
    for (const name of ['icon.png', 'icon@2x.png', 'icon@3x.png']) await fs.writeFile(path.join(artworkFolder, name), customIcon);
    const poolPath = require.resolve('../src/config/dbPool'); const previousPool = require.cache[poolPath];
    require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { query: async (sql, params) => {
      assert.match(sql, /SELECT version FROM loyalty_wallet_assets/); assert.deepEqual(params, [7, assetVersion]); return [[{ version: assetVersion }]];
    } } };
    try {
      const customized = entries(Buffer.from((await service.issueWallet({ ...input, program: { ...input.program, walletAssetVersion: assetVersion } })).passBase64, 'base64'));
      for (const name of ['icon.png', 'icon@2x.png', 'icon@3x.png']) assert.deepEqual(customized[name], customIcon, 'published restaurant icon takes precedence over default');
      const customizedManifest = JSON.parse(customized['manifest.json']);
      for (const name of Object.keys(customizedManifest)) assert.equal(require('crypto').createHash('sha1').update(customized[name]).digest('hex'), customizedManifest[name]);
      await fs.writeFile(path.join(folder, 'signature'), customized.signature); await fs.writeFile(path.join(folder, 'manifest.json'), customized['manifest.json']);
      const customVerified = await run(openssl, ['smime', '-verify', '-inform', 'DER', '-in', path.join(folder, 'signature'), '-content', path.join(folder, 'manifest.json'), '-noverify'], { windowsHide: true, encoding: 'buffer' });
      assert.deepEqual(customVerified.stdout, customized['manifest.json']);
    } finally { if (previousPool) require.cache[poolPath] = previousPool; else delete require.cache[poolPath]; }
    console.log('loyalty wallet signing: real local OpenSSL PKCS7 signature verified; manifest, stable serial/token and test label passed (not an Apple certificate acceptance test)');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
