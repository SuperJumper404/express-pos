const DomainError = require("./domainError");

const invalid = () => new DomainError(422, "DELIVERY_MONEY_INVALID", "Invalid delivery amount");
const assertCents = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
};
const toCents = (euros) => {
  if (!["number", "string"].includes(typeof euros) || (typeof euros === "number" && (!Number.isFinite(euros) || euros < 0))) throw invalid();
  let text = String(euros);
  if (typeof euros === "number" && euros > 0 && euros < 0.000001) text = euros.toFixed(20);
  if (!/^\d+(\.\d+)?$/.test(text) || text.length > 100) throw invalid();
  const [whole, fraction = ""] = text.split(".");
  const value = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2)) + (Number(fraction[2] || 0) >= 5 ? 1n : 0n);
  return assertCents(Number(value));
};
const fromCents = (cents) => assertCents(cents) / 100;
const buildDeliveryFinancials = ({ itemsTotalCents, itemsDiscountCents, deliveryFeeCents, vatRate }) => {
  [itemsTotalCents, itemsDiscountCents, deliveryFeeCents].forEach(assertCents);
  if (itemsDiscountCents > itemsTotalCents || ![5.5, 10, 20].includes(vatRate)) throw invalid();
  const itemsNetCents = itemsTotalCents - itemsDiscountCents;
  const grandTotalCents = assertCents(itemsNetCents + deliveryFeeCents);
  const divisor = BigInt(10000 + Math.round(vatRate * 100));
  const totalExclTaxCents = Number((BigInt(deliveryFeeCents) * 10000n + divisor / 2n) / divisor);
  return {
    itemsTotalCents, itemsDiscountCents, itemsNetCents, deliveryFeeCents, grandTotalCents,
    chargeSnapshot: {
      feeCents: deliveryFeeCents, totalExclTaxCents, taxCents: deliveryFeeCents - totalExclTaxCents,
      vatRate, fiscalPolicy: { mode: "configured_rate", vatRate },
    },
  };
};
module.exports = { assertCents, toCents, fromCents, buildDeliveryFinancials };
