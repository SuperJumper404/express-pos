const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildLoyaltyPhoneSession } = require('../src/helpers/loyaltyPhoneSession');
const { buildCustomerCors, isCustomerCorsRequest } = require('../src/helpers/customerCors');
const { checkoutCustomerContext, normalizeCheckoutRequestBody, canonicalPayloadHash } = require('../src/modules/m_checkout');
let controllers = {}, checkoutMiddleware = {};
try { controllers = require('../src/controllers/c_loyaltyPhone'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
try { checkoutMiddleware = require('../src/helpers/middleware/loyaltyPhoneCheckout'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const origin = 'https://staging.smarteat.fr';
const memberId = '00000000-0000-4000-8000-000000000007';
const response = () => ({ headers: {}, set(k, v) { this.headers[k] = v; return this; }, append(k, v) { this.headers[k] = v; return this; }, vary() {}, status(v) { this.statusCode = v; return this; }, json(v) { this.body = v; return this; }, end() {} });
const sessions = () => buildLoyaltyPhoneSession({ secret: 's'.repeat(64), allowedOrigins: [origin] });
const req = (extra = {}) => ({ query: { shopId: '7' }, body: {}, headers: { origin, 'x-table-session': 'table-7' }, secure: true, hostname: 'api-staging.smarteat.fr', ip: '127.0.0.1', ...extra });

test('the legacy email customer endpoint cannot create a new membership after phone-only enrolment is enabled', async () => {
  let enrolled = false;
  const controller = require('../src/controllers/c_loyalty').buildLoyaltyController({ loyalty: { enroll: async () => { enrolled = true; return { id: memberId }; } }, tableContext: { read: async () => ({ servicePointId: 3 }) } });
  const res = response(); await controller.enroll({ ...req(), customerSession: { shopId: 7, customerId: '10' } }, res);
  assert.equal(res.statusCode, 422); assert.equal(res.body.error, 'LOYALTY_PHONE_REQUIRED'); assert.equal(enrolled, false);
});

test('an unsupported cookie connection is refused before creating a phone membership', async () => {
  let enrolled = false;
  const controller = controllers.buildLoyaltyPhoneController({ sessions: sessions(), allowedOrigins: [origin], tableContext: { read: async () => ({ servicePointId: 3 }) },
    access: { lookupQuota: async () => {} }, loyalty: { enrollPhone: async () => { enrolled = true; return { member: { id: memberId }, customerId: '10' }; } } });
  const res = response(); await controller.enroll(req({ secure: false, body: { phone: '0612345678' } }), res);
  assert.equal(res.statusCode, 503); assert.equal(enrolled, false);
});

test('table phone routes open a card without customer login, protect Wallet and preserve existing consent', async () => {
  assert.equal(typeof controllers.buildLoyaltyPhoneController, 'function');
  const member = { id: memberId, balance: 50, marketingConsent: false, program: { enabled: true } }; const calls = [];
  const controller = controllers.buildLoyaltyPhoneController({ sessions: sessions(), allowedOrigins: [origin],
    tableContext: { read: async ({ token, shopId }) => token === 'table-7' && shopId === 7 ? { servicePointId: 3 } : null },
    access: { lookupQuota: async input => { calls.push(['quota', input]); } },
    loyalty: { getProgram: async () => member.program, enrollPhone: async input => { calls.push(['enroll', input]); return { member, customerId: '10' }; },
      getMember: async input => { assert.equal(input.customerId, '10'); return member; }, setMarketingConsent: async input => ({ ...member, marketingConsent: input.marketingConsent }) },
    wallet: { issueWallet: async input => { calls.push(['wallet', input]); return { provider: 'apple', passBase64: 'fake' }; } },
  });
  let res = response(); await controller.read(req(), res); assert.equal(res.statusCode, 200); assert.equal(res.body.data.session, null); assert.equal(res.body.data.canEnroll, true);
  res = response(); await controller.enroll(req({ body: { phone: '0612345678', marketingConsent: true } }), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.member.balance, 50); assert.equal(res.body.data.session.subject, 'loyalty');
  assert.equal(res.body.data.member.marketingConsent, false); assert.equal(res.body.data.rawToken, undefined);
  const cookie = res.headers['Set-Cookie'].split(';')[0]; assert.match(cookie, /^__Host-smarteat_loyalty_7=/); assert.match(res.headers['Set-Cookie'], /HttpOnly/); assert.match(res.headers['Set-Cookie'], /Secure/);
  const headers = { origin, cookie, 'x-csrf-token': res.body.data.session.csrfToken };
  res = response(); await controller.read(req({ headers }), res); assert.equal(res.body.data.member.id, memberId);
  res = response(); await controller.wallet(req({ headers, params: { provider: 'apple' } }), res); assert.equal(res.statusCode, 200);
  res = response(); await controller.wallet(req({ headers: { origin, cookie }, params: { provider: 'apple' } }), res); assert.equal(res.statusCode, 403);
  res = response(); await controller.preferences(req({ headers, body: { marketingConsent: false } }), res); assert.equal(res.statusCode, 200);
  for (const bad of [req({ headers: { origin } }), req({ query: { shopId: '8' } }), req({ headers: { origin, 'x-table-session': 'kiosk' } }), req({ headers: { origin: 'https://bad.test', 'x-table-session': 'table-7' } })]) {
    res = response(); await controller.enroll({ ...bad, body: { phone: '0612345678' } }, res); assert.equal(res.statusCode, 403);
  }
  res = response(); await controller.enroll(req({ body: { phone: '0612345678', customerId: '99' } }), res); assert.equal(res.statusCode, 422);
  assert.equal(calls.filter(c => c[0] === 'enroll').length, 1);
});

test('phone checkout authority is server-bound to table scope and CSRF, never to posted customer ids', async () => {
  assert.equal(typeof checkoutMiddleware.buildLoyaltyPhoneCheckout, 'function');
  const session = sessions(), issued = session.create({ shopId: 7, customerId: '10', memberId });
  let generalCalls = 0;
  const middleware = checkoutMiddleware.buildLoyaltyPhoneCheckout({ sessions: session, attachOptionalCustomerSession: (q, s, next) => { generalCalls++; next(); } });
  const request = req({ shopid: 7, sessionSubject: 'service_point', orderSource: 'table_qr', body: { loyalty_phone: true, customer_account_id: '999' },
    headers: { origin, cookie: `__Host-smarteat_loyalty_7=${issued.rawToken}`, 'x-csrf-token': issued.session.csrfToken } });
  let next = 0; await middleware(request, response(), () => { next++; }); assert.equal(next, 1); assert.equal(generalCalls, 0);
  assert.equal(request.customerSession, null); assert.equal(checkoutCustomerContext(request).customerId, '10');
  assert.equal(checkoutCustomerContext(request).loyaltyPhone, true);
  for (const bad of [{ ...request, orderSource: 'borne' }, { ...request, shopid: 8 }, { ...request, headers: { ...request.headers, 'x-csrf-token': '0'.repeat(64) } }]) {
    const res = response(); await middleware(bad, res, () => { throw new Error('must reject'); }); assert([401, 403].includes(res.statusCode));
  }
  await middleware(req(), response(), () => {}); assert.equal(generalCalls, 1);
  assert.equal(normalizeCheckoutRequestBody({ customer: { name: 'Guest' }, loyaltyPhoneContext: true }).loyaltyPhoneContext, undefined);
});

test('actual phone checkout requests use allowed-origin credential CORS', () => {
  const request = { method: 'POST', path: '/baseurl/api/v1/orders/checkout', headers: { origin, cookie: '__Host-smarteat_loyalty_7=signed' } };
  assert.equal(isCustomerCorsRequest(request), true);
  const res = response(); let next = false; buildCustomerCors({ allowedOrigins: [origin] })(request, res, () => { next = true; });
  assert.equal(next, true); assert.equal(res.headers['Access-Control-Allow-Origin'], origin); assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
});

test('phone reward confirmation binds points and programme version through the real checkout and replay', async () => {
  const make = () => {
    const f = require('./loyalty-kiosk-checkout.test').fixture(200, { phoneCustomer: true });
    f.repository.findServicePoint = async () => ({ id: 5, shopid: 7, type: 'table', is_active: 1 });
    const { loyaltyMemberId, loyaltyExpectedDiscountCents, ...input } = f.input;
    return { f, input: { ...input, orderSource: 'table_qr', paymentMode: 'paiement au comptoir', verifiedCustomer: { shopId: 7, customerId: '10', loyaltyPhone: true } } };
  };
  const { f, input } = make();
  assert.notEqual(canonicalPayloadHash(input), canonicalPayloadHash({ ...input, loyaltyExpectedPointsCost: 31 }));
  const result = await f.checkout.createCheckout(input); assert.equal(result.total, 8); assert.equal(f.state().member.reserved, 30);
  assert.equal(f.state().orders[0].customer_account_id, '10');
  await f.checkout.createCheckout(input); assert.equal(f.state().orders.length, 1); assert.equal(f.state().member.reserved, 30);
  for (const change of ['missing', 'points', 'version']) {
    const next = make();
    if (change === 'points') next.f.program.rewards[0].points = 31;
    if (change === 'version') next.f.setVersion(2);
    if (change === 'missing') delete next.input.loyaltyExpectedPointsCost;
    await assert.rejects(next.f.checkout.createCheckout(next.input), { code: 'LOYALTY_REQUOTE_REQUIRED' });
    assert.equal(next.f.state().orders.length, 0);
  }
});
