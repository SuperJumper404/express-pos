const assert = require('assert');
const { buildStripeTerminalPaymentService } = require('../src/services/stripeTerminalPayments');
const { buildStripeTerminalModule } = require('../src/modules/m_stripeTerminal');
const { buildStripeTerminalWebhookHandler } = require('../src/services/stripeTerminalWebhooks');
const { buildStripeTerminalController } = require('../src/controllers/c_stripeTerminal');
const { buildStripeTerminalKioskPaymentService } = require('../src/services/stripeTerminalKioskPayments');

const input = { shopId: 7, cashierUserId: 11, amountCents: 5000, attemptKey: '12345678-1234-4123-8123-123456789abc' };
const scope = { shopId: 7, cashierUserId: 11, paymentId: 41 };
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const fixture = () => {
  const state = { sessions: [], calls: [], intents: new Map(), remote: { id: 'tmr_server', status: 'online' },
    reader: { id: 21, shopid: 7, assigned_user_id: 11, is_active: 1, stripe_reader_id: 'tmr_server' } };
  let queue = Promise.resolve();
  const locks = new Set();
  const store = {
    withTransaction: async work => {
      const previous = queue; let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      try { return await work(store); } finally { release(); }
    },
    withPaymentCreationLock: async ({ paymentId }, work) => {
      if (locks.has(paymentId)) return null;
      locks.add(paymentId); try { return await work(store); } finally { locks.delete(paymentId); }
    },
    withReaderActionLock: async (data, work) => work(store),
    findAssignedReader: async ({ shopId, userId }) => state.reader && shopId === 7 && userId === 11 ? clone(state.reader) : null,
    findReader: async () => clone(state.reader),
    findActivePaymentForReader: async () => clone(state.sessions.find(row => ['creating', 'processing'].includes(row.status))),
    findPaymentByIdempotencyKey: async ({ shopId, idempotencyKey }) => clone(state.sessions.find(row => row.shopid === shopId && row.idempotency_key === idempotencyKey)),
    createStandalonePaymentSession: async data => {
      const id = 41 + state.sessions.length;
      state.sessions.push({ id, shopid: data.shopId, cashier_user_id: data.cashierUserId, terminal_reader_id: data.readerId,
        payment_kind: 'standalone', idempotency_key: data.idempotencyKey, stripe_connected_account_id: data.connectedAccountId,
        amount_cents: data.amountCents, application_fee_amount: data.applicationFeeAmount, currency: 'eur', status: 'creating',
        stripe_payment_intent_id: null, created_at: new Date().toISOString(), confirmed_at: null });
      return { affectedRows: 1, insertId: id };
    },
    findPaymentSession: async ({ shopId, paymentId }) => clone(state.sessions.find(row => row.shopid === shopId && row.id === paymentId)),
    lockPaymentSession: async data => ({ payment: await store.findPaymentSession(data) }),
    updatePaymentSession: async data => {
      const row = state.sessions.find(row => row.id === data.paymentId && row.shopid === data.shopId);
      if (!row || row.status === 'succeeded') return { affectedRows: 0 };
      for (const [key, column] of Object.entries({ stripePaymentIntentId: 'stripe_payment_intent_id', status: 'status', failureCode: 'failure_code' })) {
        if (data[key] !== undefined) row[column] = data[key];
      }
      return { affectedRows: 1 };
    },
    countPaymentAttachments: async () => 0,
    listPaymentAllocations: async () => { throw new Error('Standalone must not read allocations'); },
    finalizeStandalonePaymentSucceeded: async data => {
      const row = state.sessions.find(row => row.id === data.paymentId && row.shopid === data.shopId);
      assert.strictEqual(row.stripe_payment_intent_id, data.stripePaymentIntentId, 'Persist intent identity before finalizing');
      const finalized = row.status !== 'succeeded'; row.status = 'succeeded'; row.confirmed_at ||= data.timestamp.toISOString();
      return { finalized };
    },
    lockReaderAndOrders: async () => ({ reader: clone(state.reader), orders: [{ id: 12, subtotal: '50.00' }], activePayment: clone(state.sessions[0]) }),
  };
  const stripe = { paymentIntents: {
    create: async (params, options) => {
      state.calls.push('create');
      if (!state.intents.has(options.idempotencyKey)) state.intents.set(options.idempotencyKey, { ...params, id: 'pi_standalone', status: 'requires_payment_method' });
      if (state.loseCreateResponse) { state.loseCreateResponse = false; throw new Error('Network failure after Stripe accepted'); }
      const result = clone(state.intents.get(options.idempotencyKey));
      if (state.mismatchedIntent) result.amount = 4999;
      return result;
    },
    retrieve: async id => clone([...state.intents.values()].find(row => row.id === id)),
    cancel: async id => { state.calls.push('cancel'); const intent = [...state.intents.values()].find(row => row.id === id); intent.status = 'canceled'; return clone(intent); },
  }, terminal: { readers: {
    retrieve: async () => clone(state.remote),
    processPaymentIntent: async (id, params) => { state.calls.push('process'); state.remote.action = { type: 'process_payment_intent', status: 'in_progress', process_payment_intent: params }; return clone(state.remote); },
    cancelAction: async () => { state.calls.push('cancel-action'); state.remote.action = null; return clone(state.remote); },
  } } };
  const service = buildStripeTerminalPaymentService({ stripe, terminalStore: store,
    shopStore: { findShop: async () => ({ id: 7, stripe_account_id: 'acct_shop', stripe_charges_enabled: 1, stripe_commission_percent: 5 }) } });
  return { state, store, service };
};

(async () => {
  // Missing typed creation, replay after success or allocation reads would break this contract.
  const f = fixture();
  assert.strictEqual(typeof f.service.startStandalonePayment, 'function');
  const first = await f.service.startStandalonePayment(input);
  assert.deepStrictEqual({ ...first, createdAt: 'date' }, { id: 41, paymentKind: 'standalone', readerId: 21,
    status: 'processing', amountCents: 5000, currency: 'eur', createdAt: 'date', confirmedAt: null,
    failureCode: null, failureMessage: null, cardTicket: null, attachmentsCount: 0 });
  assert.strictEqual(f.state.sessions.length, 1);
  assert.deepStrictEqual(await f.service.startStandalonePayment(input), first);
  f.state.intents.values().next().value.status = 'succeeded';
  const paid = await f.service.getStandalonePaymentStatus(scope);
  assert.strictEqual(paid.status, 'succeeded');
  assert(paid.confirmedAt);
  assert.strictEqual((await f.service.startStandalonePayment(input)).id, 41);
  assert.strictEqual(f.state.calls.filter(name => name === 'create').length, 1);
  await assert.rejects(() => f.service.startStandalonePayment({ ...input, amountCents: 6000 }), error => error.code === 'TERMINAL_INVALID_INPUT');
  await assert.rejects(() => f.service.getPaymentStatus(scope), error => error.code === 'TERMINAL_PAYMENT_NOT_FOUND');
  await assert.rejects(() => f.service.getStandalonePaymentStatus({ ...scope, cashierUserId: 99 }), error => error.code === 'TERMINAL_PAYMENT_NOT_FOUND');
  for (const amountCents of [0, 49, 100000000, 50.5, '5000', NaN]) await assert.rejects(() => f.service.startStandalonePayment({ ...input, amountCents }), error => error.code === 'TERMINAL_INVALID_INPUT');
  for (const attemptKey of ['', 'wrong', 12, null]) await assert.rejects(() => f.service.startStandalonePayment({ ...input, attemptKey }), error => error.code === 'TERMINAL_INVALID_INPUT');

  const uncertain = fixture(); uncertain.state.loseCreateResponse = true;
  await assert.rejects(() => uncertain.service.startStandalonePayment(input), error => error.code === 'TERMINAL_STRIPE_ERROR');
  assert.strictEqual(uncertain.state.sessions[0].status, 'creating');
  await assert.rejects(() => uncertain.service.startStandalonePayment({ ...input, attemptKey: '12345678-1234-4123-8123-123456789abd' }), error => error.code === 'TERMINAL_READER_BUSY');
  assert.strictEqual((await uncertain.service.startStandalonePayment(input)).status, 'processing');
  assert.strictEqual(uncertain.state.intents.size, 1);

  const settledDuringCreation = fixture(); settledDuringCreation.state.loseCreateResponse = true;
  await assert.rejects(() => settledDuringCreation.service.startStandalonePayment(input));
  settledDuringCreation.state.intents.values().next().value.status = 'succeeded';
  assert.strictEqual((await settledDuringCreation.service.startStandalonePayment(input)).status, 'succeeded');
  assert(!settledDuringCreation.state.calls.includes('process'));
  const simultaneous = fixture();
  const results = await Promise.all([simultaneous.service.startStandalonePayment(input), simultaneous.service.startStandalonePayment(input)]);
  assert(results.every(result => result.id === 41));
  assert.strictEqual(simultaneous.state.sessions.length, 1);
  assert.strictEqual(simultaneous.state.calls.filter(name => name === 'create').length, 1);
  const waiting = fixture(); await waiting.service.startStandalonePayment(input);
  waiting.state.sessions[0].status = 'creating';
  waiting.state.intents.values().next().value.status = 'processing';
  waiting.state.remote.action = null;
  assert.strictEqual((await waiting.service.startStandalonePayment(input)).status, 'processing');
  assert.strictEqual(waiting.state.calls.filter(name => name === 'process').length, 1, 'Do not send a processing intent back for card collection');
  const malformed = fixture(); malformed.state.mismatchedIntent = true;
  await assert.rejects(() => malformed.service.startStandalonePayment(input), error => error.code === 'TERMINAL_STRIPE_ERROR');
  assert(!malformed.state.calls.includes('process'));

  const busy = fixture(); await busy.service.startStandalonePayment(input);
  busy.state.sessions[0].created_at = new Date(Date.now() - 300000).toISOString();
  await assert.rejects(() => busy.service.startPayment({ shopId: 7, cashierUserId: 11, orderIds: [12] }), error => error.code === 'TERMINAL_READER_BUSY');
  assert(!busy.state.calls.includes('cancel'));
  await assert.rejects(() => busy.service.startStandalonePayment({ ...input, attemptKey: '12345678-1234-4123-8123-123456789abd' }), error => error.code === 'TERMINAL_READER_BUSY');
  const canceling = fixture(); await canceling.service.startStandalonePayment(input);
  assert.strictEqual((await canceling.service.cancelStandalonePayment(scope)).status, 'canceled');
  assert.strictEqual((await canceling.service.startStandalonePayment(input)).status, 'canceled');
  assert.strictEqual(canceling.state.calls.filter(name => name === 'create').length, 1);
  const stale = fixture(); await stale.service.startStandalonePayment(input);
  stale.state.sessions[0].created_at = new Date(Date.now() - 300000).toISOString();
  Object.assign(stale.store, {
    findAssignedReaderByServicePoint: async () => clone(stale.state.reader),
    findKioskTerminalOrder: async () => ({ id: 12, shopid: 7, service_point_id: 99, subtotal: '50.00' }),
    findActiveKioskPaymentForOrder: async () => null,
  });
  const kioskStart = buildStripeTerminalKioskPaymentService({ stripe: {}, terminalStore: stale.store,
    checkout: { createCheckout: async () => ({ orderId: 12 }) }, shopStore: { findShop: async () => ({ id: 7, stripe_account_id: 'acct_shop', stripe_charges_enabled: 1, stripe_commission_percent: 5 }) } });
  await assert.rejects(() => kioskStart.startPayment({ shopId: 7, servicePointId: 99, checkoutPayload: {} }), error => error.code === 'TERMINAL_READER_BUSY');
  assert.strictEqual(stale.state.sessions[0].status, 'processing');
  assert(!stale.state.calls.includes('cancel'));
  const kiosk = buildStripeTerminalKioskPaymentService({ stripe: {}, terminalStore: busy.store, checkout: {}, shopStore: {} });
  busy.state.sessions[0].status = 'succeeded';
  await assert.rejects(() => kiosk.getPaymentStatus({ shopId: 7, servicePointId: 99, paymentId: 41 }), error => error.code === 'TERMINAL_PAYMENT_NOT_FOUND');

  const controller = buildStripeTerminalController({ paymentService: f.service });
  assert.strictEqual(typeof controller.startStandalonePayment, 'function');
  const response = { status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return data; } };
  await controller.startStandalonePayment({ shopid: 7, id: 11, access: 1, sessionSubject: 'staff', body: { ...input, shopId: 99, cashierUserId: 99 } }, response);
  assert.strictEqual(response.body.data.id, 41);
  const auth = require('../src/helpers/middleware/auth');
  const denied = { status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return data; } };
  await auth.buildModuleAuthorization({ moduleKey: 'history', findUserByIdAndShop: async () => { throw new Error('private-db-password'); } })({ access: 1, sessionSubject: 'staff', id: 11, shopid: 7 }, denied, () => assert.fail('must deny'));
  assert(!JSON.stringify(denied.body).includes('private-db-password'));
  const cached = ['../src/controllers/c_stripe', '../src/controllers/c_orderEditing'].map(require.resolve);
  const previous = cached.map(path => require.cache[path]);
  cached.forEach(path => { require.cache[path] = { exports: new Proxy({}, { get: () => () => {} }) }; });
  const { routers } = require('../src/routers/r_stripe');
  cached.forEach((path, index) => { if (previous[index]) require.cache[path] = previous[index]; else delete require.cache[path]; });
  for (const [method, path] of [['post', '/stripe/terminal/standalone-payments'], ['get', '/stripe/terminal/standalone-payments/:id'], ['post', '/stripe/terminal/standalone-payments/:id/cancel']]) {
    const route = routers.stack.find(layer => layer.route && layer.route.path === path && layer.route.methods[method]);
    assert(route, path);
    assert.deepStrictEqual(route.route.stack.slice(0, 2).map(layer => layer.handle), [auth.authentication, auth.authorizeCashRegister]);
  }
  for (const [method, path] of [['get', '/stripe/terminal/history'], ['get', '/stripe/terminal/standalone-payments/attachment-candidates'], ['get', '/stripe/terminal/standalone-payments/:id/attachments'], ['post', '/stripe/terminal/standalone-payments/:id/attachments'], ['delete', '/stripe/terminal/standalone-payments/:id/attachments/:archiveId']]) {
    const route = routers.stack.find(layer => layer.route && layer.route.path === path && layer.route.methods[method]);
    assert(route, path);
    assert.deepStrictEqual(route.route.stack.slice(0, 2).map(layer => layer.handle), [auth.authentication, auth.authorizeHistory]);
  }

  // The real module must choose the no-order finalizer and persist confirmation once.
  const sqlCalls = []; const row = { id: 41, shopid: 7, payment_kind: 'standalone', status: 'processing', stripe_payment_intent_id: 'pi_standalone', amount_cents: 5000, currency: 'eur' };
  const moduleStore = buildStripeTerminalModule({ connection: { query: async (sql, params) => {
    sqlCalls.push({ sql, params });
    if (/FROM stripe_terminal_payments(?: p)?\b/.test(sql)) return [[clone(row)]];
    if (/UPDATE stripe_terminal_payments/.test(sql)) { row.status = 'succeeded'; return [{ affectedRows: 1 }]; }
    throw new Error('Unexpected order/allocation query: ' + sql);
  } } });
  const event = { type: 'payment_intent.succeeded', created: 1700000000, data: { object: { id: 'pi_standalone', status: 'succeeded', amount: 5000, currency: 'eur', metadata: { shop_id: '7', terminal_payment_id: '41', payment_kind: 'standalone' } } } };
  const webhook = buildStripeTerminalWebhookHandler({ terminalStore: { ...moduleStore, withTransaction: work => work(moduleStore) } });
  assert.strictEqual((await webhook(event)).finalized, true);
  assert.strictEqual((await webhook(event)).finalized, false);
  assert(sqlCalls.some(call => /confirmed_at/.test(call.sql)));
  assert(!sqlCalls.some(call => /(?:FROM|UPDATE|JOIN) (?:orders|archives|stripe_terminal_payment_orders)\b/.test(call.sql)));
  console.log('Standalone Terminal payments: passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
