const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const filename = path.join(__dirname, '../src/helpers/pinVault.js');
const vault = fs.existsSync(filename) ? require(filename) : {};
const context = { kind: 'staff', shopId: 7, loginId: 'ABCD23' };
const configured = (run) => {
  const previous = process.env.PIN_ENCRYPTION_KEY;
  process.env.PIN_ENCRYPTION_KEY = Buffer.alloc(32, 37).toString('base64');
  try { return run(); }
  finally {
    if (previous === undefined) delete process.env.PIN_ENCRYPTION_KEY;
    else process.env.PIN_ENCRYPTION_KEY = previous;
  }
};

test('PIN vault preserves leading zeroes and never embeds the PIN in its envelope', () => configured(() => {
  assert.equal(typeof vault.encryptPin, 'function');
  const encrypted = vault.encryptPin('0042', context);
  assert.equal(vault.decryptPin(encrypted, context), '0042');
  assert.notEqual(encrypted, '0042');
  assert.ok(encrypted.length < 255);
}));

test('PIN vault uses a fresh IV for every encryption of the same PIN', () => configured(() => {
  assert.equal(typeof vault.encryptPin, 'function');
  const first = vault.encryptPin('0042', context);
  const second = vault.encryptPin('0042', context);
  assert.notEqual(first, second);
  assert.equal(vault.decryptPin(first, context), '0042');
  assert.equal(vault.decryptPin(second, context), '0042');
}));

test('PIN vault rejects a swapped tenant, login or credential kind', () => configured(() => {
  assert.equal(typeof vault.encryptPin, 'function');
  const encrypted = vault.encryptPin('0042', context);
  for (const wrong of [{ ...context, shopId: 8 }, { ...context, loginId: 'ABCD24' }, { ...context, kind: 'kiosk' }]) {
    assert.throws(() => vault.decryptPin(encrypted, wrong), { code: 'PIN_VAULT_UNAVAILABLE' });
  }
}));

test('PIN vault refuses altered ciphertext and a wrong encryption key', () => configured(() => {
  assert.equal(typeof vault.encryptPin, 'function');
  const encrypted = vault.encryptPin('0042', context);
  const parts = encrypted.split('.');
  parts[parts.length - 1] = crypto.randomBytes(4).toString('base64url');
  assert.throws(() => vault.decryptPin(parts.join('.'), context), { code: 'PIN_VAULT_UNAVAILABLE' });
  process.env.PIN_ENCRYPTION_KEY = Buffer.alloc(32, 38).toString('base64');
  assert.throws(() => vault.decryptPin(encrypted, context), { code: 'PIN_VAULT_UNAVAILABLE' });
}));

test('PIN vault fails closed for absent, weak or malformed keys', () => configured(() => {
  assert.equal(typeof vault.encryptPin, 'function');
  for (const key of ['', 'short', Buffer.alloc(16, 1).toString('base64'), 'A'.repeat(10000)]) {
    process.env.PIN_ENCRYPTION_KEY = key;
    assert.throws(() => vault.encryptPin('0042', context), { code: 'PIN_VAULT_UNAVAILABLE' });
  }
}));

test('PIN vault rejects invalid PINs, contexts, versions and malformed envelopes', () => configured(() => {
  assert.equal(typeof vault.encryptPin, 'function');
  for (const pin of ['123', '12345', 'abcd', '', null]) assert.throws(() => vault.encryptPin(pin, context));
  for (const wrong of [{ ...context, shopId: 0 }, { ...context, kind: 'other' }, { ...context, loginId: '' }]) {
    assert.throws(() => vault.encryptPin('0042', wrong));
  }
  for (const encrypted of ['', '0042', 'v2.a.b.c', 'v1.a.b.c', 'v1.a.b.c.extra', 'a'.repeat(10000)]) {
    assert.throws(() => vault.decryptPin(encrypted, context), { code: 'PIN_VAULT_UNAVAILABLE' });
  }
}));
