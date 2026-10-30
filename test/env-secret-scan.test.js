const assert = require('assert');
const filterSecretMatches = require('../scripts/secret-scan-filter');
const pattern = '(sk_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|DOTENV_PRIVATE_KEY[A-Z0-9_]*=dotenvx://)';
const fakeKey = ['sk', 'test', 'disposable', 'task17'].join('_');
const fakeWebhook = ['whsec', 'disposable', 'task17'].join('_');
const path = '35f5359:test/delivery-journey.integration.test.js:14:';
assert.strictEqual(filterSecretMatches(path + fakeKey, pattern), '');
assert.strictEqual(filterSecretMatches(path + fakeWebhook, pattern), '');
for (const value of [fakeKey + 'A', fakeWebhook + '_extra', ['sk', 'live', 'disposable', 'task17'].join('_'), ['sk', 'test', 'A'.repeat(32)].join('_')]) {
  const line = path + value;
  assert.strictEqual(filterSecretMatches(line, pattern), line);
}
const differentFile = '35f5359:src/config/stripe.js:1:' + fakeKey;
assert.strictEqual(filterSecretMatches(differentFile, pattern), differentFile);
const mixed = path + fakeKey + ' ' + ['whsec', 'B'.repeat(32)].join('_');
assert.strictEqual(filterSecretMatches(mixed, pattern), mixed);
const privateKey = path + 'DOTENV_PRIVATE' + '_KEY=dotenvx://not-a-fixture';
assert.strictEqual(filterSecretMatches(privateKey, pattern), privateKey);
assert.strictEqual(filterSecretMatches(path + fakeKey + '\n' + differentFile, pattern), differentFile);
console.log('Secret scan keeps real matches and excludes only the two historical test fixtures');
