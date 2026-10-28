const assert = require('assert/strict');
const crypto = require('crypto');
const { buildWalletPayload, buildLoyaltyWallet, createZip, signJwt, invalidPushToken } = require('../src/services/loyaltyWallet');

const input = { shopId: 7, member: { id: 'member-1', qr: 'a'.repeat(64), balance: 120 },
  program: { name: 'Restaurant', enabled: true, logoUrl: 'https://example.com/logo.png', backgroundColor: '#123456', foregroundColor: '#ffffff', rewards: [
    { id: 'crepe', name: 'Crêpe offerte', points: 100 }, { id: 'menu', name: 'Menu', points: 200 },
  ] }, offersUrl: 'https://example.com/compte/fidelite?shopId=7' };

(async () => {
  const payload = buildWalletPayload(input);
  assert.equal(payload.balance, 120);
  assert.equal(payload.qr, input.member.qr);
  assert.match(payload.offer, /Crêpe/);
  assert.match(payload.next, /200/);
  const held = buildWalletPayload({ ...input, member: { ...input.member, reserved: 50 } });
  assert.equal(held.balance, 120, 'display the actual balance');
  assert.equal(held.available, 70, 'reserved points cannot fund another reward');
  assert.doesNotMatch(held.offer, /Crêpe/);
  assert.match(held.next, /100/);
  assert.equal(JSON.stringify(payload).includes('phone'), false);
  assert.equal(invalidPushToken(400, 'BadDeviceToken'), true);
  assert.equal(invalidPushToken(410, 'Unregistered'), true);
  assert.equal(invalidPushToken(400, 'BadTopic'), false);
  assert.equal(invalidPushToken(403, 'BadCertificate'), false);
  assert.throws(() => buildWalletPayload({ ...input, offersUrl: 'javascript:alert(1)' }));
  const zip = createZip({ 'pass.json': Buffer.from('{}'), signature: Buffer.from('test') });
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const token = signJwt({ aud: 'google' }, privateKey);
  const parts = token.split('.');
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url')), true);
  const disabled = buildLoyaltyWallet({ getConfig: () => ({ mode: 'development' }) });
  await assert.rejects(() => disabled.issueWallet({ ...input, provider: 'apple' }), error => error.code === 'WALLET_NOT_CONFIGURED' && error.status === 503);
  const calls = [];
  const repository = { ensurePass: async scope => ({ ...scope, serial: 'stable-serial', auth_token: 'b'.repeat(64) }) };
  const config = { mode: 'development', offersBaseUrl: 'https://example.com', googleIssuerId: '1234', googleEmail: 'wallet@example.com',
    googlePrivateKey: privateKey, googleOrigins: ['https://example.com'] };
  const service = buildLoyaltyWallet({ getConfig: () => config, repository,
    request: async request => { calls.push(request); return { status: request.url.includes('oauth2') ? 200 : 404, data: request.url.includes('oauth2') ? { access_token: 'access', expires_in: 3600 } : {} }; } });
  // Issuance updates stable class/object first; unexpected provider failures never become success.
  await assert.rejects(() => service.issueWallet({ ...input, provider: 'google' }));
  assert.equal(calls.some(call => /loyaltyClass\/1234\.smarteat_7/.test(call.url)), true);
  const successCalls = [];
  const ready = buildLoyaltyWallet({ getConfig: () => config, repository,
    request: async request => { successCalls.push(request); return { status: 200, data: request.url.includes('oauth2') ? { access_token: 'access', expires_in: 3600 } : {} }; } });
  const issued = await ready.issueWallet({ ...input, provider: 'google' });
  assert.equal(issued.mode, 'development');
  assert.match(issued.url, /^https:\/\/pay.google.com\/gp\/v\/save\//);
  const body = JSON.parse(Buffer.from(issued.url.split('/').pop().split('.')[1], 'base64url'));
  assert.equal(body.payload.loyaltyObjects[0].id, '1234.smarteat_7_stable-serial');
  assert.equal(successCalls.filter(call => call.method === 'PATCH' && call.url.includes('loyaltyObject')).length, 1);
  console.log('loyalty wallet: payload, ZIP, signature, stable Google IDs, provider failures and disabled mode passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
