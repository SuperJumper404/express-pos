const DomainError = require('./domainError');
const { parseModulePermissions } = require('./staffPermissions');
const assertCheckoutPaymentAuthority = ({ paymentMode, discountValue = 0, sessionSubject, actor }) => {
  if (!String(paymentMode).toLowerCase().startsWith('counter_pay_before:') && Number(discountValue) === 0) return;
  const permissions = actor && (parseModulePermissions(actor.module_permissions, actor.access)
    || []);
  if (sessionSubject !== 'staff' || !actor || Number(actor.status) !== 1 || !(Number(actor.access) === 0
    || (Number(actor.access) === 1 && permissions.includes('cashregister')))) {
    throw new DomainError(403, 'CHECKOUT_PAYMENT_FORBIDDEN', 'An authorized cashier must confirm payment or manual discounts');
  }
};
module.exports = { assertCheckoutPaymentAuthority };
