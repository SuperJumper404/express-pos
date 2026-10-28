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
    await Promise.all(['icon.png', 'icon@2x.png'].map(name => fs.writeFile(path.join(folder, name), png)));
    const config = { mode: 'development', offersBaseUrl: 'https://example.test', applePassTypeId: 'pass.test.smarteat', appleTeamId: 'TESTTEAM',
      appleCertificatePath: cert, appleKeyPath: key, appleWwdrPath: cert, appleAssetsPath: folder, appleWebServiceUrl: 'https://example.test/api/v1/wallet/apple', opensslPath: openssl };
    const pass = { serial: 'local-test-serial', auth_token: 'b'.repeat(64) };
    const service = buildLoyaltyWallet({ getConfig: () => config, repository: { ensurePass: async () => pass } });
    const input = { provider: 'apple', shopId: 7, program: { name: 'Local Test', enabled: true, rewards: [] }, member: { id: 'm', qr: 'a'.repeat(64), balance: 120 } };
    const first = await service.issueWallet(input); const second = await service.issueWallet({ ...input, member: { ...input.member, balance: 200 } });
    assert.equal(first.mode, 'development');
    const files = entries(Buffer.from(first.passBase64, 'base64'));
    const json = JSON.parse(files['pass.json']); const updated = JSON.parse(entries(Buffer.from(second.passBase64, 'base64'))['pass.json']);
    assert.equal(json.serialNumber, updated.serialNumber); assert.equal(json.authenticationToken, updated.authenticationToken);
    assert.equal(updated.storeCard.primaryFields[0].value, 200); assert.match(json.logoText, /TEST/);
    assert.equal(json.barcodes[0].message, input.member.qr); assert.ok(!json.storeCard.backFields[0].value.includes('auth'));
    const manifest = JSON.parse(files['manifest.json']);
    for (const name of Object.keys(manifest)) assert.equal(require('crypto').createHash('sha1').update(files[name]).digest('hex'), manifest[name]);
    await fs.writeFile(path.join(folder, 'signature'), files.signature); await fs.writeFile(path.join(folder, 'manifest.json'), files['manifest.json']);
    const verified = await run(openssl, ['smime', '-verify', '-inform', 'DER', '-in', path.join(folder, 'signature'), '-content', path.join(folder, 'manifest.json'), '-noverify'], { windowsHide: true, encoding: 'buffer' });
    assert.deepEqual(verified.stdout, files['manifest.json']);
    console.log('loyalty wallet signing: real local OpenSSL PKCS7 signature verified; manifest, stable serial/token and test label passed (not an Apple certificate acceptance test)');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
