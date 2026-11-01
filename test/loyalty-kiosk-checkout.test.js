const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildCheckoutModule, canonicalPayloadHash } = require('../src/modules/m_checkout');
const { buildLoyalty } = require('../src/modules/m_loyalty');
const { normalizeProgram } = require('../src/helpers/loyalty');
const memberId = '00000000-0000-4000-8000-000000000001';

function fixture(value = 200) {
  let state = { member: { id: memberId, shopid: 7, customer_id: '10', qr: 'a'.repeat(64), card_number: '0001234567890123', balance: 50, reserved: 0, revision: 1 }, orders: [], details: [], loyaltyOrders: [], ledger: [] };
  let tail = Promise.resolve();
  const connection = { query: async () => [[]] };
  const transact = work => {
    const pending = tail.then(async () => { const before = structuredClone(state); try { return await work(connection); } catch (e) { state = before; throw e; } });
    tail = pending.catch(() => {}); return pending;
  };
  const program = normalizeProgram({ enabled: true, rewards: [{ id: 'coffee', name: 'Café', type: 'fixed', value, points: 30 }] });
  const loyaltyRepository = {
    lockShop: async () => {}, program: async () => ({ config: program, version: 1 }),
    member: async ({ shopId, memberId: id }) => shopId === 7 && (!id || id === memberId) ? state.member : null,
    saveMember: async ({ connection, ...member }) => Object.assign(state.member, member), history: async () => state.ledger,
    sourceOrder: async ({ shopId, orderId }) => state.orders.find(o => o.shopid === shopId && o.id === Number(orderId)),
    order: async ({ shopId, orderId }) => state.loyaltyOrders.find(o => o.shopid === shopId && o.order_id === Number(orderId)),
    insertOrder: async ({ connection, ...o }) => state.loyaltyOrders.push({ status: 'attached', points_cost: 0, discount_cents: 0, paid_cents: 0, refunded_cents: 0, restored_points: 0, ...o }),
    saveOrder: async ({ connection, ...o }) => Object.assign(state.loyaltyOrders.find(row => row.order_id === o.order_id), o),
    lines: async ({ orderId }) => state.details.filter(d => d.orderid === orderId).map(d => ({ productId: d.productid, quantity: d.qty, unitCents: Math.round(d.price * 100), totalCents: Math.round(d.total * 100) })),
    checkoutLines: async ({ orderId }) => state.details.filter(d => d.orderid === orderId),
    applyCheckoutPrice: async ({ orderId, subtotalCents, lines, discountAmount, discountType, discountValue, subtotalBeforeDiscount }) => {
      Object.assign(state.orders.find(o => o.id === orderId), { subtotal: subtotalCents / 100, discount_amount: discountAmount, discount_type: discountType, discount_value: discountValue, subtotal_before_discount: subtotalBeforeDiscount });
      for (const line of lines) Object.assign(state.details.find(d => d.id === line.id), line);
    },
    event: async ({ eventKey }) => state.ledger.find(l => l.eventKey === eventKey), ledger: async ({ connection, ...entry }) => state.ledger.push(entry), enqueue: async () => {},
    paymentBusy: async () => false,
  };
  const loyalty = buildLoyalty({ repository: loyaltyRepository, runInTransaction: transact });
  const repository = {
    getProducts: async () => [{ id: 21, shopid: 7, name: 'Plat', price: 10, vat_rate: 10, track_stock: 0, archived: 0, is_hidden: 0 }],
    findOrderByToken: async ({ token }) => state.orders.find(o => o.client_order_token === token),
    findServicePoint: async () => ({ id: 5, shopid: 7, type: 'kiosk', is_active: 1 }),
    insertOrder: async ({ order }) => { const id = state.orders.length + 1; state.orders.push({ id, ...order }); return { insertId: id }; },
    insertOrderDetail: async ({ detail }) => { const id = state.details.length + 1; state.details.push({ id, ...detail }); return { insertId: id }; },
    lockExpiredReservations: async () => [],
  };
  const checkout = buildCheckoutModule({ repository, withTransaction: transact, loyalty, getResolvedProductConfigurations: async () => new Map() });
  const input = { shopId: 7, sessionSubject: 'service_point', servicePointId: 5, orderSource: 'borne', customer: { name: 'Client', phone: '0612345678' }, items: [{ productId: 21, quantity: 1, selectedChoiceIds: [] }], expectedTotal: 10, paymentMode: 'stripe_terminal_kiosk', clientOrderToken: 'attempt-1', loyaltyMemberId: memberId, loyaltyRewardId: 'coffee', loyaltyConfirmed: true, loyaltyExpectedDiscountCents: value };
  return { checkout, loyalty, input, state: () => state, program, repository, transact };
}

test('kiosk preview prices real products without writing or reserving points', async () => {
  const f = fixture(); assert.equal(typeof f.checkout.previewLoyaltyCheckout, 'function');
  const preview = await f.checkout.previewLoyaltyCheckout(f.input);
  assert.equal(preview.grossCents, 1000); assert.equal(preview.discountCents, 200); assert.equal(preview.totalCents, 800); assert.equal(preview.pointsCost, 30);
  assert.equal(f.state().orders.length, 0); assert.equal(f.state().member.reserved, 0);
});
test('kiosk attaches and reserves in checkout, then pays and earns once without a personal account session', async () => {
  const f = fixture(); const created = await f.checkout.createCheckout(f.input);
  assert.equal(created.total, 8); assert.equal(f.state().member.reserved, 30); assert.equal(f.state().member.balance, 50);
  assert.equal(f.state().orders[0].customer_account_id, undefined); assert.equal(f.state().orders[0].subtotal, 8);
  await f.transact(connection => f.loyalty.settlePaidOrder({ connection, shopId: 7, orderId: created.orderId, paymentKey: 'terminal:1', paidCents: 800 }));
  assert.equal(f.state().member.balance, 28); assert.equal(f.state().member.reserved, 0);
  await f.transact(connection => f.loyalty.settlePaidOrder({ connection, shopId: 7, orderId: created.orderId, paymentKey: 'terminal:1', paidCents: 800 }));
  assert.equal(f.state().member.balance, 28);
  assert.equal((await f.checkout.createCheckout(f.input)).idempotent_replay, true);
});
test('changed discount, unavailable points and wrong source roll back checkout', async () => {
  const f = fixture();
  await assert.rejects(f.checkout.createCheckout({ ...f.input, loyaltyExpectedDiscountCents: 100 }), { code: 'LOYALTY_REQUOTE_REQUIRED' });
  assert.equal(f.state().orders.length, 0); assert.equal(f.state().member.reserved, 0);
  f.state().member.reserved = 40;
  await assert.rejects(f.checkout.createCheckout(f.input), { code: 'LOYALTY_INSUFFICIENT_POINTS' });
  assert.equal(f.state().orders.length, 0);
  await assert.rejects(f.checkout.createCheckout({ ...f.input, orderSource: 'web' }));
  await assert.rejects(f.checkout.createCheckout({ ...f.input, loyaltyConfirmed: false }));
});
test('loyalty identity and confirmed discount participate in checkout idempotence', () => {
  const { input } = fixture();
  assert.notEqual(canonicalPayloadHash(input), canonicalPayloadHash({ ...input, loyaltyMemberId: '00000000-0000-4000-8000-000000000002' }));
  assert.notEqual(canonicalPayloadHash(input), canonicalPayloadHash({ ...input, loyaltyExpectedDiscountCents: 100 }));
});
test('a fully rewarded kiosk order is settled without Stripe and a tiny positive remainder requires counter payment', async () => {
  const free = fixture(1000); const result = await free.checkout.createCheckout({ ...free.input, paymentMode: 'loyalty_zero_total' });
  assert.equal(result.total, 0); assert.equal(result.payment_status, 'paid'); assert.equal(free.state().member.balance, 20);
  const small = fixture(975);
  await assert.rejects(small.checkout.createCheckout(small.input), { code: 'LOYALTY_COUNTER_PAYMENT_REQUIRED' });
  assert.equal(small.state().orders.length, 0); assert.equal(small.state().member.reserved, 0);
  const counter = await small.checkout.createCheckout({ ...small.input, paymentMode: 'paiement au comptoir' });
  assert.equal(counter.total, 0.25); assert.equal(counter.payment_status, 'unpaid');
  await assert.rejects(fixture().checkout.createCheckout({ ...fixture().input, paymentMode: 'loyalty_zero_total' }));
});
test('an authorized staff kiosk session can redeem a fully rewarded basket without cashier administration rights', async () => {
  const f = fixture(1000);
  f.repository.findUserById = async () => ({ id: 8, access: 4, status: 1, module_permissions: ['borne'] });
  const result = await f.checkout.createCheckout({ ...f.input, actorId: 8, sessionSubject: 'staff', paymentMode: 'loyalty_zero_total' });
  assert.equal(result.total, 0); assert.equal(result.payment_status, 'paid');
});
test('concurrent kiosk attempts cannot spend the same points and an expired offer leaves no order', async () => {
  const f = fixture();
  const attempts = await Promise.allSettled([f.checkout.createCheckout(f.input), f.checkout.createCheckout({ ...f.input, clientOrderToken: 'attempt-2' })]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal(f.state().member.reserved, 30);
  const expired = fixture(); expired.program.rewards[0].expiresAt = '2020-01-01T00:00:00Z';
  await assert.rejects(expired.checkout.createCheckout(expired.input), { code: 'LOYALTY_REWARD_UNAVAILABLE' });
  assert.equal(expired.state().orders.length, 0);
});
