const DomainError = require("../helpers/domainError");
const { calculateDiscount } = require("../helpers/discount");
const { toCents, fromCents, buildDeliveryFinancials } = require("../helpers/deliveryMoney");
const { distanceMeters, priceDelivery } = require("../helpers/deliveryPricing");
const { buildDeliveryTokenCodec, signAddressResolution, validateAddressResolution, validTokenTime } = require("../helpers/deliveryAddress");

const invalidRequest = () => new DomainError(400, "DELIVERY_REQUEST_INVALID", "Invalid delivery quote request");
const positiveId = value => (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const normalizeQuoteItems = items => {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw invalidRequest();
  return items.map(item => {
    if (!item || !positiveId(item.productId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000
      || !Array.isArray(item.selectedChoiceIds) || item.selectedChoiceIds.length > 100 || !item.selectedChoiceIds.every(positiveId)) throw invalidRequest();
    return { productId: Number(item.productId), quantity: item.quantity, selectedChoiceIds: item.selectedChoiceIds.map(Number).sort((a, b) => a - b) };
  });
};
const normalizeQuoteDiscount = (discount) => {
  if (discount === undefined) return { type: "none", value: 0 };
  if (!discount || !["none", "amount", "percent"].includes(discount.type) || typeof discount.value !== "number"
    || !Number.isFinite(discount.value) || discount.value < 0 || (discount.type === "percent" && discount.value > 100)
    || (discount.type === "none" && discount.value !== 0)) throw invalidRequest();
  if (discount.type === "amount") toCents(discount.value);
  return { type: discount.type, value: discount.value };
};
const buildDeliveryQuotes = ({
  repository = require("./m_deliverySettings").buildSqlDeliverySettingsRepository(),
  quoteOrderItems = require("./m_orderQuote").quoteOrderItems,
  geocoder = require("../services/deliveryGeocoding").buildDeliveryGeocoding(),
  clock = () => new Date(), tokenCodec = buildDeliveryTokenCodec(),
} = {}) => ({
  async resolveAddress({ shopId, address, candidateId }) {
    if (!positiveId(shopId)) throw invalidRequest();
    const addressSnapshot = await geocoder.resolve({ shopId, address, candidateId });
    const now = clock();
    return {
      addressSnapshot,
      addressResolutionToken: signAddressResolution({ shopId, addressSnapshot, now, tokenCodec }),
      expiresAt: new Date(new Date(now).getTime() + 900000).toISOString(),
    };
  },
  async createQuote({ shopId, items, discount, addressResolutionToken, connection }) {
    if (!positiveId(shopId)) throw invalidRequest();
    const normalizedItems = normalizeQuoteItems(items);
    // Internal callers supply only an already-authorized discount intent; HTTP enforces actor privileges.
    const intent = normalizeQuoteDiscount(discount);
    const settings = await repository.getSettings({ shopId, connection });
    if (!settings.enabled) throw new DomainError(422, "DELIVERY_DISABLED", "Delivery is disabled");
    const now = clock();
    const addressSnapshot = validateAddressResolution(addressResolutionToken, now, { tokenCodec, shopId });
    const itemQuote = await quoteOrderItems({ shopId, items: normalizedItems, isTakeaway: true, connection });
    const itemsTotalCents = toCents(itemQuote.total);
    const calculated = calculateDiscount({ subtotal: fromCents(itemsTotalCents), ...intent });
    const itemsDiscountCents = toCents(calculated.amount);
    const distance = distanceMeters(settings.origin, addressSnapshot);
    const { deliveryFeeCents } = priceDelivery({ settings, distanceMeters: distance, itemsNetCents: itemsTotalCents - itemsDiscountCents });
    const financials = buildDeliveryFinancials({ itemsTotalCents, itemsDiscountCents, deliveryFeeCents, vatRate: settings.fiscalPolicy.vatRate });
    financials.chargeSnapshot.bandFeeCents = settings.bands.find(band => distance <= band.upToMeters).feeCents;
    financials.chargeSnapshot.freeDeliveryApplied = settings.freeDeliveryEnabled && financials.itemsNetCents >= settings.freeDeliveryThresholdCents;
    const expiresAt = new Date(new Date(now).getTime() + 300000).toISOString();
    const quote = { shopId, settingsRevision: settings.revision, addressSnapshot, distanceMeters: distance, ...financials, expiresAt };
    const quoteToken = tokenCodec.sign({ kind: "quote", ...quote, items: normalizedItems, discount: intent, issuedAt: new Date(now).toISOString() });
    return { ...quote, quoteToken };
  },
  validateQuoteToken(token, { shopId } = {}) {
    let payload;
    try { payload = tokenCodec.verify(token); } catch (error) {
      if (error.code === "DELIVERY_UNAVAILABLE") throw error;
      throw new DomainError(409, "DELIVERY_QUOTE_CHANGED", "Delivery quote must be refreshed");
    }
    if (!payload || payload.kind !== "quote" || !validTokenTime(payload, clock(), 300000)
      || (shopId !== undefined && String(payload.shopId) !== String(shopId))) throw new DomainError(409, "DELIVERY_QUOTE_CHANGED", "Delivery quote must be refreshed");
    return payload;
  },
});
module.exports = { normalizeQuoteItems, normalizeQuoteDiscount, buildDeliveryQuotes };
