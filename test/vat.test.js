const assert = require("assert");
const { buildVatSnapshot, normalizeVatRate } = require("../src/helpers/vat");

assert.deepStrictEqual(buildVatSnapshot({ unitPrice: 10, quantity: 1, vatRate: 10 }), {
  vatRate: 10,
  unitPriceHt: 9.09,
  unitVat: 0.91,
  totalHt: 9.09,
  totalVat: 0.91,
});

assert.deepStrictEqual(buildVatSnapshot({ unitPrice: 1.05, quantity: 2, vatRate: 5.5 }), {
  vatRate: 5.5,
  unitPriceHt: 1,
  unitVat: 0.05,
  totalHt: 1.99,
  totalVat: 0.11,
});

assert.deepStrictEqual(buildVatSnapshot({ unitPrice: 12, quantity: 1, vatRate: 20 }), {
  vatRate: 20,
  unitPriceHt: 10,
  unitVat: 2,
  totalHt: 10,
  totalVat: 2,
});

for (const vatRate of [5.5, 10, 20]) assert.strictEqual(normalizeVatRate(vatRate), vatRate);
assert.strictEqual(normalizeVatRate(undefined), 10);
assert.throws(() => normalizeVatRate(8), /VAT_RATE_INVALID/);
assert.throws(() => normalizeVatRate(20.1), /VAT_RATE_INVALID/);

console.log("vat tests passed");
