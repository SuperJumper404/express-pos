const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildCheckoutModule } = require('../src/modules/m_checkout');
const { buildLoyalty } = require('../src/modules/m_loyalty');
const { normalizeProgram } = require('../src/helpers/loyalty');

function fixture({ member = true, qr = false } = {}) {
  const state = { orders: [], details: [], loyaltyOrders: [], ledger: [], resolutions: [] };
  const connection = { query: async () => [[{ id: '10' }]] };
  const transact = work => work(connection);
  const card = { id: 'member', shopid: 7, customer_id: '10', balance: 50, reserved: 0, revision: 1 };
  const program = normalizeProgram({ enabled: true });
  const loyaltyRepository = {
    program: async () => ({ config: program, version: 1 }),
    member: async ({ shopId, customerId, memberId }) => member && shopId === 7 && (customerId === '10' || memberId === card.id) ? card : null,
    sourceOrder: async ({ orderId }) => state.orders.find(o => o.id === orderId),
    order: async ({ orderId }) => state.loyaltyOrders.find(o => o.order_id === orderId),
    insertOrder: async ({ connection, ...order }) => state.loyaltyOrders.push({ status: 'attached', points_cost: 0, discount_cents: 0, ...order }),
    lines: async ({ orderId }) => state.details.filter(d => d.orderid === orderId).map(d => ({ productId: d.productid, quantity: d.qty, unitCents: d.price * 100, totalCents: d.total * 100 })),
    saveOrder: async order => Object.assign(state.loyaltyOrders.find(o => o.order_id === order.order_id), order),
    saveMember: async row => Object.assign(card, row),
    event: async ({ eventKey }) => state.ledger.find(row => row.eventKey === eventKey),
    ledger: async row => state.ledger.push(row), enqueue: async () => {},
  };
  const loyalty = buildLoyalty({ repository: loyaltyRepository, runInTransaction: transact });
  const customerPhone = { resolveForCheckout: async scope => {
    state.resolutions.push(scope);
    return { status: 'resolved', phone: '+33612345678', created: false, customer: { id: '10', shopId: 7 }, loyalty: member ? { id: card.id } : null };
  } };
  const actor = { id: 8, shopid: 7, access: 1, status: 1, module_permissions: ['orders', 'cashregister'] };
  const point = { id: 5, shopid: 7, type: qr ? 'table' : 'counter', is_active: 1 };
  const repository = {
    getProducts: async () => [{ id: 21, shopid: 7, name: 'Plat', price: 10, vat_rate: 10, track_stock: 0, archived: 0, is_hidden: 0 }],
    findOrderByToken: async ({ token }) => state.orders.find(o => o.client_order_token === token),
    findServicePoint: async () => point, findSystemPoint: async () => point,
    findUserById: async () => actor,
    insertOrder: async ({ order }) => { const id = state.orders.length + 1; state.orders.push({ id, ...order }); return { insertId: id }; },
    insertOrderDetail: async ({ detail }) => { state.details.push(detail); return { insertId: state.details.length }; },
    lockExpiredReservations: async () => [],
  };
  const checkout = buildCheckoutModule({ repository, withTransaction: transact, loyalty, customerPhone, getResolvedProductConfigurations: async () => new Map() });
  const input = { shopId: 7, sessionSubject: qr ? 'service_point' : 'staff', actorId: qr ? null : 8, servicePointId: 5,
    orderSource: qr ? 'table_qr' : 'pos', customer: { name: 'Client', phone: '0612345678', id: 999 },
    items: [{ productId: 21, quantity: 1, selectedChoiceIds: [] }], expectedTotal: 10, paymentMode: 'paiement au comptoir', clientOrderToken: 'phone-1', customer_profile_id: 'forged' };
  return { checkout, loyalty, loyaltyRepository, customerPhone, state, card, connection, input, actor, point, program };
}

test('cashier phone checkout links an internal profile without creating an account or membership', async () => {
  const f = fixture({ member: false });
  await f.checkout.createCheckout(f.input);
  assert.equal(f.state.orders[0].customer_profile_id, '10');
  assert.equal(f.state.orders[0].customer_account_id, undefined);
  assert.equal(f.state.resolutions.length, 1);
  assert.equal(f.state.resolutions[0].connection, f.connection);
  assert.equal(f.state.resolutions[0].phone, f.input.customer.phone);
  assert.equal(f.state.loyaltyOrders.length, 0); assert.equal(f.state.ledger.length, 0);
});

test('table QR attaches an existing card, credits only confirmed payment and never spends points', async () => {
  const f = fixture({ qr: true });
  const created = await f.checkout.createCheckout(f.input);
  assert.equal(f.state.orders[0].customer_profile_id, '10');
  assert.equal(f.state.orders[0].customer_account_id, undefined);
  assert.equal(f.state.loyaltyOrders.length, 1); assert.equal(f.state.ledger.length, 0);
  assert.equal(f.card.balance, 50); assert.equal(f.card.reserved, 0);
  const scope = { connection: f.connection, shopId: 7, orderId: created.orderId, paymentKey: 'stripe:one', paidCents: 1000 };
  await f.loyalty.settlePaidOrder(scope); await f.loyalty.settlePaidOrder(scope);
  assert.equal(f.card.balance, 60); assert.equal(f.state.ledger.length, 1); assert.equal(f.state.ledger[0].kind, 'earn');
});

test('paid cashier checkout credits once and replay does no phone work even after mapping changes', async () => {
  const f = fixture(); const input = { ...f.input, paymentMode: 'counter_pay_before:Espèces' };
  const first = await f.checkout.createCheckout(input);
  assert.equal(f.card.balance, 60);
  f.customerPhone.resolveForCheckout = async () => { throw new Error('replay must not resolve or create another profile'); };
  assert.equal((await f.checkout.createCheckout(input)).orderId, first.orderId);
  assert.equal(f.state.orders.length, 1); assert.equal(f.state.orders[0].customer_profile_id, '10'); assert.equal(f.card.balance, 60);
});

test('invalid or ambiguous phones remain guest orders; database errors fail checkout', async () => {
  for (const qr of [false, true]) {
    const f = fixture({ qr }); f.customerPhone.resolveForCheckout = async () => null;
    await f.checkout.createCheckout(f.input); assert.equal(f.state.orders[0].customer_profile_id, undefined);
    assert.equal(f.state.loyaltyOrders.length, 0);
  }
  const f = fixture(); f.customerPhone.resolveForCheckout = async () => { throw new Error('database unavailable'); };
  await assert.rejects(f.checkout.createCheckout(f.input), /database unavailable/); assert.equal(f.state.orders.length, 0);
});

test('phone context mismatch rejects before insertion and matching context keeps authenticated ownership', async () => {
  const f = fixture({ qr: true });
  await assert.rejects(f.checkout.createCheckout({ ...f.input, verifiedCustomer: { shopId: 7, customerId: '11' } }), { code: 'CUSTOMER_PHONE_CONTEXT_CHANGED', status: 409 });
  assert.equal(f.state.orders.length, 0);
  await f.checkout.createCheckout({ ...f.input, verifiedCustomer: { shopId: 7, customerId: '10' } });
  assert.equal(f.state.orders[0].customer_account_id, '10'); assert.equal(f.state.orders[0].customer_profile_id, '10');
});

test('ineligible staff, kiosk, web and inactive table never resolve a profile', async () => {
  for (const mode of ['permissions', 'inactive-staff', 'kiosk', 'web', 'inactive-table']) {
    const f = fixture({ qr: ['web', 'inactive-table'].includes(mode) });
    if (mode === 'permissions') f.actor.module_permissions = ['borne'];
    if (mode === 'inactive-staff') f.actor.status = 0;
    if (mode === 'kiosk') f.point.type = 'kiosk';
    if (mode === 'web') { f.input.orderSource = 'web'; f.point.type = 'click_collect'; }
    if (mode === 'inactive-table') f.point.is_active = 0;
    try { await f.checkout.createCheckout(f.input); } catch (error) { assert.equal(error.code, 'SERVICE_POINT_INVALID'); }
    assert.equal(f.state.resolutions.length, 0, mode);
  }
  const f = fixture();
  await assert.rejects(f.checkout.createCheckout({ ...f.input, expectedTotal: 9 }), { code: 'ORDER_REPRICE_REQUIRED' });
  assert.equal(f.state.resolutions.length, 0);
});

test('settlement can attach by the persisted internal profile and refuses a forged profile scope', async () => {
  const f = fixture();
  f.state.orders.push({ id: 1, shopid: 7, customer_profile_id: '10' });
  await assert.rejects(f.loyalty.attachProfileOrder({ connection: f.connection, shopId: 7, orderId: 1, customerId: '11' }), { code: 'LOYALTY_NOT_FOUND' });
  await f.loyalty.settlePaidOrder({ connection: f.connection, shopId: 7, orderId: 1, paymentKey: 'counter:1', paidCents: 1000 });
  assert.equal(f.card.balance, 60); assert.equal(f.state.loyaltyOrders.length, 1);
});

test('disabled loyalty still permits profile attribution without loyalty writes', async () => {
  const f = fixture(); f.program.enabled = false;
  await f.checkout.createCheckout(f.input);
  assert.equal(f.state.orders[0].customer_profile_id, '10'); assert.equal(f.state.loyaltyOrders.length, 0); assert.equal(f.state.ledger.length, 0);
});
