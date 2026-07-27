const { parseMoney } = require("./money");

const ALLOWED_VAT_RATES = [5.5, 10, 20];

const normalizeVatRate = (value, fallback = 10) => {
  const parsed = Number(value === undefined || value === null || value === "" ? fallback : value);
  if (!ALLOWED_VAT_RATES.includes(parsed)) throw new Error("VAT_RATE_INVALID");
  return parsed;
};

const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (value) => parseMoney(value / 100);

const buildVatSnapshot = ({ unitPrice, quantity, vatRate }) => {
  const normalizedUnitPrice = parseMoney(unitPrice);
  const normalizedQuantity = Number(quantity);
  if (normalizedUnitPrice === null || !Number.isInteger(normalizedQuantity) || normalizedQuantity < 1) {
    throw new Error("VAT_SNAPSHOT_INPUT_INVALID");
  }

  const rate = normalizeVatRate(vatRate);
  const divisor = 10000 + Math.round(rate * 100);
  const unitTtcCents = toCents(normalizedUnitPrice);
  const totalTtcCents = unitTtcCents * normalizedQuantity;
  const unitHtCents = Math.round((unitTtcCents * 10000) / divisor);
  const totalHtCents = Math.round((totalTtcCents * 10000) / divisor);

  return {
    vatRate: rate,
    unitPriceHt: fromCents(unitHtCents),
    unitVat: fromCents(unitTtcCents - unitHtCents),
    totalHt: fromCents(totalHtCents),
    totalVat: fromCents(totalTtcCents - totalHtCents),
  };
};

module.exports = {
  ALLOWED_VAT_RATES,
  buildVatSnapshot,
  normalizeVatRate,
};
