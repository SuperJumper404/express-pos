const assert = require('assert');
const { buildLoyalty } = require('../src/modules/m_loyalty');
const { normalizeProgram } = require('../src/helpers/loyalty');
let state = { program: normalizeProgram({ enabled: true, rewards: [{ id: 'r', name: 'Café', points: 30, type: 'fixed', value: 200 }] }),
  members: [{ id: 'm', shopid: 1, customer_id: '10', qr: 'a'.repeat(64), balance: 50, reserved: 0, revision: 1 }], orders: [], ledger: [], jobs: [] };
let tail = Promise.resolve();
let now = new Date('2026-10-24T12:00:00Z');
let paymentBusy = false;
let checkoutPrice = 1000;
let currentLines = [];
const transaction = work => {
  const next = tail.then(async () => {
    const saved = structuredClone(state);
    try { return await work({ query() {} }); } catch (error) { state = saved; throw error; }
  });
  tail = next.catch(() => {}); return next;
};
const repository = {
  lockShop: async () => {},
  program: async () => ({ config: state.program, version: 1 }),
  customer: async ({ shopId, customerId }) => shopId === 1 && customerId === '10' ? { id: '10' } : null,
  member: async ({ shopId, memberId, customerId, qr }) => state.members.find(m => m.shopid === shopId &&
    (memberId ? m.id === memberId : customerId ? m.customer_id === customerId : m.qr === qr)),
  insertMember: async ({ connection, ...m }) => { state.members.push(m); },
  saveMember: async ({ connection, ...m }) => { Object.assign(state.members.find(row => row.id === m.id), m); },
  history: async ({ memberId }) => state.ledger.filter(row => row.memberId === memberId),
  order: async ({ shopId, orderId }) => state.orders.find(o => o.shopid === shopId && o.order_id === Number(orderId)),
  saveOrder: async ({ connection, ...o }) => { Object.assign(state.orders.find(row => row.order_id === o.order_id && row.shopid === o.shopid), o); },
  insertOrder: async ({ connection, ...o }) => { state.orders.push({ status: 'attached', paid_cents: 0, refunded_cents: 0, restored_points: 0, points_cost: 0, discount_cents: 0, reward_snapshot: null, reservation_expires_at: null, ...o }); },
  sourceOrder: async ({ shopId, orderId }) => shopId === 1 ? { id: Number(orderId), subtotal: checkoutPrice / 100, customer_account_id: '10' } : null,
  checkoutLines: async () => [{ id: 1, total: 10, price: 5, qty: 2, vat_rate: 10 }],
  applyCheckoutPrice: async ({ subtotalCents }) => { checkoutPrice = subtotalCents; },
  lines: async () => currentLines,
  event: async ({ shopId, eventKey }) => state.ledger.find(row => row.shopId === shopId && row.eventKey === eventKey),
  ledger: async ({ connection, ...entry }) => { state.ledger.push(entry); },
  enqueue: async ({ connection, ...entry }) => { state.jobs.push(entry); },
  paymentBusy: async () => paymentBusy,
  expired: async () => state.orders.filter(o => o.status === 'reserved').map(o => ({ shopid: o.shopid, order_id: o.order_id })),
};
const service = buildLoyalty({ repository, runInTransaction: transaction, clock: () => now });
(async () => {
  assert.deepStrictEqual(await transaction(connection => service.release({ connection, shopId: 1, orderId: 999 })), { released: false }, 'guest cancellation must not require loyalty membership');
  const a = await service.attach({ shopId: 1, orderId: 1, qr: 'a'.repeat(64) });
  assert.strictEqual(a.memberId, 'm');
  await service.attach({ shopId: 1, orderId: 2, qr: 'a'.repeat(64) });
  const concurrent = await Promise.allSettled([service.reserve({ shopId: 1, orderId: 1, rewardId: 'r', confirmed: true }),
    service.reserve({ shopId: 1, orderId: 2, rewardId: 'r', confirmed: true })]);
  assert.strictEqual(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.strictEqual(state.members[0].reserved, 30);
  assert.strictEqual(state.members[0].balance, 50, 'scan/reserve never spends points');
  await assert.rejects(service.reserve({ shopId: 1, orderId: 2, rewardId: 'r' }), error => error.code === 'LOYALTY_CONFIRMATION_REQUIRED');
  await transaction(connection => service.settlePaidOrder({ connection, shopId: 1, orderId: 1, paymentKey: 'p1', paidCents: 800 }));
  assert.strictEqual(state.members[0].balance, 28);
  assert.strictEqual(state.members[0].reserved, 0);
  await transaction(connection => service.settlePaidOrder({ connection, shopId: 1, orderId: 1, paymentKey: 'p1', paidCents: 800 }));
  assert.strictEqual(state.members[0].balance, 28, 'replay must not credit twice');
  await transaction(connection => service.settlePaidOrder({ connection, shopId: 1, orderId: 1, paymentKey: 'p2', paidCents: 800 }));
  assert.strictEqual(state.members[0].balance, 28, 'same order with another payment key must not credit twice');
  await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 1, refundKey: 'rf1', refundedCents: 400 }));
  assert.strictEqual(state.members[0].balance, 43);
  await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 1, refundKey: 'rf1', refundedCents: 400 }));
  assert.strictEqual(state.members[0].balance, 43);
  await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 1, refundKey: 'rf2', refundedCents: 400 }));
  assert.strictEqual(state.members[0].balance, 58, 'earned points retained, spent points fully restored');
  await assert.rejects(service.lookup({ shopId: 2, qr: 'a'.repeat(64) }), error => error.status === 404);
  await assert.rejects(service.adjust({ shopId: 1, memberId: 'm', points: 5, reason: '', actorId: 1 }), error => error.status === 422);
  await service.adjust({ shopId: 1, memberId: 'm', points: -8, reason: 'Correction caisse', actorId: 1 });
  assert.strictEqual(state.members[0].balance, 50);
  await service.reserve({ shopId: 1, orderId: 2, rewardId: 'r', confirmed: true });
  await service.release({ shopId: 1, orderId: 2 });
  assert.strictEqual(state.members[0].reserved, 0);
  assert.strictEqual(state.members[0].balance, 50, 'failed payment releases points without spend');
  await service.reserve({ shopId: 1, orderId: 2, rewardId: 'r', confirmed: true });
  now = new Date('2026-10-24T12:20:00Z');
  paymentBusy = true;
  await service.expireReservations();
  assert.strictEqual(state.members[0].reserved, 30, 'payment in flight keeps points reserved after deadline');
  await assert.rejects(service.release({ shopId: 1, orderId: 2 }), error => error.code === 'LOYALTY_PAYMENT_ACTIVE');
  await assert.rejects(transaction(connection => service.getOrderDiscount({ connection, shopId: 1, orderId: 2, subtotalCents: 1000 })), error => error.code === 'LOYALTY_RESERVATION_EXPIRED');
  paymentBusy = false;
  await service.expireReservations();
  assert.strictEqual(state.members[0].reserved, 0);
  assert.strictEqual(state.members[0].balance, 50);
  const member = await service.enroll({ shopId: 1, customerId: '10' });
  assert.strictEqual(member.id, 'm', 're-enrollment preserves membership and points');
  assert.strictEqual(member.balance, 50);
  paymentBusy = true;
  await assert.rejects(service.reserve({ shopId: 1, orderId: 2, rewardId: 'r', confirmed: true }), error => error.code === 'LOYALTY_PAYMENT_ACTIVE');
  paymentBusy = false;
  const reward = await transaction(connection => service.applyCheckoutReward({ connection, shopId: 1, orderId: 3, customerId: '10', rewardId: 'r', confirmed: true }));
  assert.strictEqual(reward.totalCents, 800);
  assert.strictEqual(checkoutPrice, 800);
  const alreadyApplied = await transaction(connection => service.getOrderDiscount({ connection, shopId: 1, orderId: 3, subtotalCents: 800 }));
  assert.strictEqual(alreadyApplied.discountCents, 0, 'checkout reward must not be applied again on collection');
  await assert.rejects(transaction(connection => service.getOrderDiscount({ connection, shopId: 1, orderId: 3, subtotalCents: 800, otherDiscountCents: 100 })), error => error.code === 'LOYALTY_NOT_STACKABLE');
  await service.release({ shopId: 1, orderId: 3 });
  assert.strictEqual(checkoutPrice, 1000, 'released checkout reward restores original price');
  assert.deepStrictEqual(await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 999, refundKey: 'guest-refund', refundedCents: 1000 })), { restored: false });
  const balanceBeforeUnspentRefund = state.members[0].balance;
  await service.attach({ shopId: 1, orderId: 4, qr: 'a'.repeat(64) });
  await transaction(connection => service.settlePaidOrder({ connection, shopId: 1, orderId: 4, paymentKey: 'no-reward', paidCents: 1000 }));
  await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 4, refundKey: 'no-spend-refund', refundedCents: 1000 }));
  assert.strictEqual(state.members[0].balance, balanceBeforeUnspentRefund + 10, 'refund without a redemption retains earned points and creates no extra restitution');
  await service.attach({ shopId: 1, orderId: 5, qr: 'a'.repeat(64) });
  await service.reserve({ shopId: 1, orderId: 5, rewardId: 'r', confirmed: true });
  await transaction(connection => service.settlePaidOrder({ connection, shopId: 1, orderId: 5, paymentKey: 'cumulative-payment', paidCents: 1000 }));
  const beforeCumulative = state.members[0].balance;
  await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 5, refundKey: 'cumulative600', refundedCents: 200, cumulativeRefundedCents: 600 }));
  assert.strictEqual(state.members[0].balance, beforeCumulative + 18, 'authoritative cumulative amount includes earlier missed partial refunds');
  await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 5, refundKey: 'cumulative1000', refundedCents: 400, cumulativeRefundedCents: 1000 }));
  assert.strictEqual(state.members[0].balance, beforeCumulative + 30);
  await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 5, refundKey: 'reordered600', refundedCents: 200, cumulativeRefundedCents: 600 }));
  await transaction(connection => service.refundOrder({ connection, shopId: 1, orderId: 5, refundKey: 'repeat1000', refundedCents: 400, cumulativeRefundedCents: 1000 }));
  assert.strictEqual(state.members[0].balance, beforeCumulative + 30, 'repeated and reordered cumulative events cannot restore twice');
  state.program.excludedProductIds = [21];
  currentLines = [{ productId: 21, totalCents: 1000, unitCents: 1000, quantity: 1 }];
  await service.attach({ shopId: 1, orderId: 6, qr: 'a'.repeat(64) });
  currentLines = [{ productId: 22, totalCents: 1000, unitCents: 1000, quantity: 1 }];
  const beforeEditedOrder = state.members[0].balance;
  await transaction(connection => service.settlePaidOrder({ connection, shopId: 1, orderId: 6, paymentKey: 'edited-order', paidCents: 1000 }));
  assert.strictEqual(state.members[0].balance, beforeEditedOrder + 10, 'unreserved edited order uses current lines with snapshotted program rules');
  assert(state.jobs.length > 0, 'Wallet sync queued transactionally');
  console.log('loyalty service tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
