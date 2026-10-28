const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSmsTransport } = require('../src/services/customerSms');
const { normalizeCustomerDestination } = require('../src/helpers/customerIdentity');

test('SMS numbers use the existing international phone normalizer', () => {
  assert.equal(normalizeCustomerDestination({ channel: 'sms', value: '06 12 34 56 78', countryCode: 'FR' }), '+33612345678');
  assert.throws(() => normalizeCustomerDestination({ channel: 'sms', value: '123' }));
});
test('development SMS is explicit and cannot run in production', async () => {
  const transport = buildSmsTransport({ getConfig: () => ({ mode: 'development', nodeEnv: 'local' }) });
  assert.equal(transport.available(), true);
  assert.deepEqual(await transport.send({ destination: '+33612345678', code: '123456' }), { accepted: true, development: true });
  const production = buildSmsTransport({ getConfig: () => ({ mode: 'development', nodeEnv: 'production' }) });
  assert.equal(production.available(), false);
  await assert.rejects(production.send({ destination: '+33612345678', code: '123456' }));
});
test('Twilio requires complete credentials and validates provider acceptance', async () => {
  const config = { mode: 'twilio', accountSid: 'AC' + 'a'.repeat(32), authToken: 'fixture', from: '+33123456789' };
  let sent;
  const transport = buildSmsTransport({ getConfig: () => config, request: async input => { sent = input; return { statusCode: 201, body: { sid: 'SM' + 'b'.repeat(32), status: 'queued' } }; } });
  assert.equal(transport.available(), true);
  assert.equal((await transport.send({ destination: '+33612345678', code: '123456' })).accepted, true);
  assert.equal(sent.hostname, 'api.twilio.com');
  assert.equal(new URLSearchParams(sent.body).get('To'), '+33612345678');
  assert.match(new URLSearchParams(sent.body).get('Body'), /123456/);
  const failing = buildSmsTransport({ getConfig: () => config, request: async () => ({ statusCode: 400, body: { message: 'sensitive' } }) });
  await assert.rejects(failing.send({ destination: '+33612345678', code: '123456' }), error => error.code === 'CUSTOMER_CODE_UNAVAILABLE' && !error.message.includes('sensitive'));
});
