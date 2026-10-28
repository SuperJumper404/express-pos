const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertCheckoutPaymentAuthority } = require('../src/helpers/checkoutPaymentAuthority');
test('table QR cannot declare payment collected or apply a manual discount', () => {
  for (const input of [{ paymentMode: 'counter_pay_before:cash' }, { paymentMode: 'cash', discountValue: 10 }]) {
    assert.throws(() => assertCheckoutPaymentAuthority({ ...input, sessionSubject: 'service_point' }), { code: 'CHECKOUT_PAYMENT_FORBIDDEN' });
    assert.throws(() => assertCheckoutPaymentAuthority({ ...input, sessionSubject: 'staff', actor: { access: 2, status: 1 } }), { code: 'CHECKOUT_PAYMENT_FORBIDDEN' });
  }
});
test('active cashier with permission can settle; guest ordering remains possible', () => {
  assertCheckoutPaymentAuthority({ paymentMode: 'cash', sessionSubject: 'service_point' });
  assertCheckoutPaymentAuthority({ paymentMode: 'counter_pay_before:cash', sessionSubject: 'staff', actor: { access: 1, status: 1, module_permissions: '["cashregister"]' } });
  assert.throws(() => assertCheckoutPaymentAuthority({ paymentMode: 'counter_pay_before:cash', sessionSubject: 'staff', actor: { access: 1, status: 1, module_permissions: '[]' } }), { code: 'CHECKOUT_PAYMENT_FORBIDDEN' });
  assert.throws(() => assertCheckoutPaymentAuthority({ paymentMode: 'counter_pay_before:cash', sessionSubject: 'staff', actor: { access: 1, status: 1 } }), { code: 'CHECKOUT_PAYMENT_FORBIDDEN' });
});
