const { normalizePaymentMethod } = require('./paymentMethod');

const validateCashDeclaration = declaration => {
  if (declaration === undefined) return null;
  const keys = ['declared_cash_cents', 'declared_card_cents'];
  if (!declaration || keys.some(key => !Number.isSafeInteger(declaration[key]) || declaration[key] < 0)) {
    const error = new Error('Saisissez les montants espèces et carte en centimes entiers positifs ou nuls.');
    error.statusCode = 422;
    throw error;
  }
  return Object.fromEntries(keys.map(key => [key, declaration[key]]));
};

const buildCashReconciliation = (snapshot, declaration) => {
  const declared = validateCashDeclaration(declaration);
  const totals = {};
  for (const row of snapshot.payments_summary || []) {
    const method = normalizePaymentMethod(row.payment, row.payment_provider);
    totals[method] = (totals[method] || 0) + Math.round(Number(row.total || 0) * 100);
  }
  const cash = snapshot.courier_cash;
  const expectedCash = cash
    ? Number(cash.register_cash_sales_cents || 0) + Number(cash.received_cents || 0) - Number(cash.cash_refunded_by_register_cents || 0)
    : totals['Espèces'] || 0;
  const expectedCard = (totals['Carte bancaire'] || 0) + (totals['TPE Stripe'] || 0);
  return {
    expected_cash_cents: expectedCash, expected_card_cents: expectedCard,
    declared_cash_cents: declared ? declared.declared_cash_cents : null,
    declared_card_cents: declared ? declared.declared_card_cents : null,
    cash_difference_cents: declared ? declared.declared_cash_cents - expectedCash : null,
    card_difference_cents: declared ? declared.declared_card_cents - expectedCard : null,
  };
};

module.exports = { validateCashDeclaration, buildCashReconciliation };
