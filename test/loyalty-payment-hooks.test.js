const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildPaymentModule } = require('../src/modules/m_payments');

test('only reliable payment completion credits loyalty, using the same transaction', async () => {
  const connection = {};
  const order = { id: 42, shopid: 7, stripe_payment_intent_id: 'pi_test', payment_status: 'requires_payment' };
  const calls = [];
  const payment = { order_id: 42, shop_id: 7, amount_cents: 1234 };
  const service = buildPaymentModule({
    repository: { findPaymentByIntent: async () => payment, lockOrder: async () => order,
      updatePaymentSucceeded: async () => {}, updateOrderSucceeded: async () => { order.payment_status = 'paid'; },
      updatePaymentPending: async () => {} },
    withTransaction: work => work(connection), finalizeReservations: async () => {},
    loyalty: { settlePaidOrder: async scope => calls.push(scope) },
  });
  await service.markPaymentProcessing('pi_test');
  assert.equal(calls.length, 0);
  await service.markPaymentSucceeded({ id: 'pi_test', latest_charge: 'ch_test' });
  assert.deepEqual(calls, [{ connection, shopId: 7, orderId: 42, paymentKey: 'stripe:pi_test', paidCents: 1234 }]);
  await service.markPaymentSucceeded({ id: 'pi_test' });
  assert.equal(calls.length, 1);
});
test('failed/canceled payment releases held points inside its transaction', async () => {
  const connection = {};
  let released;
  const service = buildPaymentModule({
    repository: { findPaymentByIntent: async () => ({ order_id: 42, shop_id: 7 }),
      lockOrder: async () => ({ id: 42, shopid: 7, stripe_payment_intent_id: 'pi_test', payment_status: 'requires_payment' }),
      updatePaymentTerminal: async () => {}, updateOrderTerminal: async () => {} },
    withTransaction: work => work(connection), finalizeReservations: async () => {},
    loyalty: { release: async scope => { released = scope; } },
  });
  await service.markPaymentCanceled('pi_test');
  assert.deepEqual(released, { connection, shopId: 7, orderId: 42 });
});
test('provisional and orphaned cancellations release points immediately', async () => {
  for (const orphaned of [false, true]) {
    const connection = {};
    let released;
    const service = buildPaymentModule({ repository: {
      lockOrder: async () => ({ id: 42, shopid: 7, status: 1, payment_provider: 'stripe', payment_status: 'requires_payment', stripe_payment_intent_id: orphaned ? null : 'pi_test' }),
      cancelPaymentsForOrder: async () => {}, cancelProvisionalOrder: async () => {}, cancelOrphanedProvisionalOrder: async () => ({ affectedRows: 1 }),
    }, withTransaction: work => work(connection), finalizeReservations: async () => {}, loyalty: { release: async scope => { released = scope; } } });
    if (orphaned) await service.cancelOrphanedProvisionalStripeOrder(42, 7);
    else await service.cancelProvisionalStripeOrder(42, 7, 'pi_test');
    assert.deepEqual(released, { connection, shopId: 7, orderId: 42 });
  }
});
test('partial Stripe refund passes authoritative cumulative amount for missed events', async () => {
  const connection = {};
  let observed;
  const payment = { order_id: 42, shop_id: 7, stripe_payment_intent_id: 'pi_test', stripe_charge_id: 'ch_test', amount_cents: 1000, status: 'succeeded' };
  const service = buildPaymentModule({ repository: {
    lockOrder: async () => ({ id: 42, shopid: 7, payment_provider: 'stripe', payment_status: 'paid', stripe_payment_intent_id: 'pi_test' }),
    findPaymentForOrderRefund: async () => payment,
  }, withTransaction: work => work(connection), loyalty: { refundOrder: async scope => { observed = scope; } } });
  await service.recordRefundState({ orderId: 42, shopId: 7, refund: { id: 're_test', status: 'succeeded', amount: 200,
    cumulative_succeeded_amount: 600, payment_intent: 'pi_test', charge: 'ch_test' } });
  assert.deepEqual(observed, { connection, shopId: 7, orderId: 42, refundedCents: 200, cumulativeRefundedCents: 600, refundKey: 'stripe:re_test:total:600' });
});
test('manual archived delivery refund uses original order ID, not archive ID', async () => {
  const { buildDeliveryRefunds } = require('../src/modules/m_deliveryRefunds');
  const connection = {};
  let observed;
  const current = { orderKind: 'archive', delivery: { id: '41', origin_order_id: 42, shopid: 7, charge: { feeCents: 0 } },
    order: { id: 999, subtotal: 10, subtotal_before_discount: 10, discount_amount: 0, payment_status: 'paid', payment_provider: null, payment: 'Espèces' } };
  const service = buildDeliveryRefunds({ runInTransaction: work => work(connection),
    loyalty: { refundOrder: async scope => { observed = scope; } },
    repository: { lockShop: async () => ({ id: 7 }), resolve: async () => current,
      source: async () => ({ id: '31', payment_origin: 'register', payment_id: 5, amount_cents: 1000, method: 'cash', payment_label: 'Espèces' }),
      account: async () => ({ id: 10, shopid: 7, status: 1, access: 0 }), replay: async () => null,
      payment: async () => ({ id: 5, order_id: 42, status: 'succeeded', amount_cents: 1000, currency: 'eur', stripe_payment_intent_id: 'manual_register_delivery:41', payment_method: 'Espèces' }),
      postingTime: async () => '2026-10-24 12:00:00', appendRefund: async () => '51', markRefunded: async () => {},
    } });
  await service.refund({ actor: { subject: 'staff', id: 10, shopId: 7 }, deliveryId: '41', returnSource: 'register', reason: 'Retour confirmé', idempotencyKey: 'fixture' });
  assert.deepEqual(observed, { connection, shopId: 7, orderId: 42, refundedCents: 1000, refundKey: 'manual:register:51' });
});
