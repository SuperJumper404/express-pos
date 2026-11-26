const DomainError = require("../helpers/domainError");
const { assertCents, toCents, calculateDeliveryDiscount, buildDeliveryFinancials } = require("../helpers/deliveryMoney");
const { distanceMeters, priceDelivery, validateDeliverySettings } = require("../helpers/deliveryPricing");
const { buildDeliveryTokenCodec, signAddressResolution, validateAddressResolution, validTokenTime } = require("../helpers/deliveryAddress");
const { isGoogleReference } = require("../helpers/deliveryAddressStorage");

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
  calculateDeliveryDiscount({ itemsTotalCents: 0, type: discount.type, value: discount.value });
  return { type: discount.type, value: discount.value };
};
const buildDeliveryQuotes = ({
  repository = require("./m_deliverySettings").buildSqlDeliverySettingsRepository(),
  quoteOrderItems = require("./m_orderQuote").quoteOrderItems,
  geocoder = require("../services/deliveryGeocoding").buildDeliveryGeocoding(),
  places = require("../services/googleDeliveryPlaces").googleDeliveryPlaces,
  clock = () => new Date(), tokenCodec = buildDeliveryTokenCodec(),
} = {}) => {
  const getOrigin = async (shopId, origin) => {
    if (!isGoogleReference(origin)) return origin;
    try { return await places.position({ shopId: Number(shopId), placeId: origin.placeId }); }
    catch (error) {
      if (error.code !== "DELIVERY_GEOCODING_UNAVAILABLE") throw error;
      throw new DomainError(503, "DELIVERY_ORIGIN_UNAVAILABLE", "Restaurant delivery origin is unavailable");
    }
  };
  const getSettings = async (shopId, connection) => validateDeliverySettings(await repository.getSettings({ shopId, connection }));
  return {
    async suggestAddresses({ shopId, input, sessionToken, includeDistance = false }) {
      if (!positiveId(shopId) || typeof input !== "string" || input.trim().length < 3 || input.length > 255 || /[\x00-\x1f\x7f]/.test(input)
        || typeof includeDistance !== "boolean" || !require("../services/googleDeliveryPlaces").validSessionToken(sessionToken)) throw invalidRequest();
      tokenCodec.sign({ kind: "preflight" });
      const query = input.trim().normalize("NFC");
      let origin;
      if (includeDistance) {
        const settings = await getSettings(shopId);
        if (settings.enabled) {
          try { origin = await getOrigin(shopId, settings.origin); }
          catch (error) {
            if (!["DELIVERY_ORIGIN_UNAVAILABLE", "DELIVERY_GEOCODING_RATE_LIMITED"].includes(error.code)) throw error;
          }
        }
      }
      let suggestions = [];
      try { suggestions = await places.suggest({ shopId: Number(shopId), input: query, sessionToken, ...(origin && { origin }) }); }
      catch (error) {
        if (error.code !== "DELIVERY_GEOCODING_UNAVAILABLE" || typeof geocoder.suggest !== "function") throw error;
      }
      const now = new Date(clock());
      if (suggestions.length || typeof geocoder.suggest !== "function") {
        return { suggestions: suggestions.slice(0, 5).map(row => ({ ...row, selectionToken: require("../helpers/deliveryAddress").signPlaceSelection({
          shopId, placeId: row.placeId, label: row.label, sessionToken, now, tokenCodec }) })) };
      }
      const postal = await geocoder.suggest({ shopId: Number(shopId), input: query, origin });
      return { suggestions: postal.slice(0, 5).map(address => ({
        placeId: "ign:" + address.providerId, label: address.providerLabel, provider: "ign",
        ...(origin && { distanceMeters: distanceMeters(origin, address) }),
        selectionToken: tokenCodec.sign({ kind: "postal_selection", shopId, addressSnapshot: address,
          issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900000).toISOString() }),
      })) };
    },
    async resolveAddress({ shopId, address, candidateId, selectionToken }) {
      if (!positiveId(shopId)) throw invalidRequest();
      // Validate lazy signer configuration before consuming supplier quota.
      tokenCodec.sign({ kind: "preflight" });
      let addressSnapshot;
      if (selectionToken !== undefined) {
        if (address !== undefined || candidateId !== undefined) throw invalidRequest();
        const selected = tokenCodec.verify(selectionToken);
        if (selected && selected.kind === "postal_selection") {
          if (String(selected.shopId) !== String(shopId) || !validTokenTime(selected, clock(), 900000)) {
            throw new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Invalid or expired address selection");
          }
          addressSnapshot = selected.addressSnapshot;
        } else {
          const place = require("../helpers/deliveryAddress").validatePlaceSelection(selectionToken, clock(), { shopId, tokenCodec });
          addressSnapshot = { ...await places.resolve({ shopId: Number(shopId), placeId: place.placeId, sessionToken: place.sessionToken }), selectedLabel: place.label };
        }
      } else addressSnapshot = await geocoder.resolve({ shopId, address, candidateId });
      const now = clock();
      return {
        addressSnapshot,
        addressResolutionToken: signAddressResolution({ shopId, addressSnapshot, now, tokenCodec }),
        expiresAt: new Date(new Date(now).getTime() + 900000).toISOString(),
      };
    },
    async previewAddress({ shopId, addressResolutionToken }) {
      if (!positiveId(shopId)) throw invalidRequest();
      const address = validateAddressResolution(addressResolutionToken, clock(), { tokenCodec, shopId });
      const settings = await getSettings(shopId);
      if (!settings.enabled) throw new DomainError(422, "DELIVERY_DISABLED", "Delivery is disabled");
      const distance = distanceMeters(await getOrigin(shopId, settings.origin), address);
      const band = settings.bands.find(value => distance <= value.upToMeters);
      return {
        distanceMeters: distance, maxDistanceMeters: settings.maxDistanceMeters,
        inRange: Boolean(band), suggestedFeeCents: band ? band.feeCents : null,
        feeOptionsCents: [...new Set(settings.bands.map(value => value.feeCents))].sort((a, b) => a - b),
      };
    },
    async createQuote({ shopId, items, discount, addressResolutionToken, deliveryFeeOverrideCents, connection }) {
      if (!positiveId(shopId)) throw invalidRequest();
      const normalizedItems = normalizeQuoteItems(items);
      // Internal callers supply only an already-authorized discount intent; HTTP enforces actor privileges.
      const intent = normalizeQuoteDiscount(discount);
      if (deliveryFeeOverrideCents !== undefined) assertCents(deliveryFeeOverrideCents);
      const settings = await getSettings(shopId, connection);
      if (!settings.enabled) throw new DomainError(422, "DELIVERY_DISABLED", "Delivery is disabled");
      const now = clock();
      const addressSnapshot = validateAddressResolution(addressResolutionToken, now, { tokenCodec, shopId });
      const itemQuote = await quoteOrderItems({ shopId, items: normalizedItems, isTakeaway: true, connection });
      const itemsTotalCents = toCents(itemQuote.total);
      const { itemsDiscountCents } = calculateDeliveryDiscount({ itemsTotalCents, ...intent });
      const origin = await getOrigin(shopId, settings.origin);
      const distance = distanceMeters(origin, addressSnapshot);
      const { deliveryFeeCents: suggestedFee } = priceDelivery({ settings, distanceMeters: distance, itemsNetCents: itemsTotalCents - itemsDiscountCents });
      const deliveryFeeCents = deliveryFeeOverrideCents === undefined ? suggestedFee : deliveryFeeOverrideCents;
      const financials = buildDeliveryFinancials({ itemsTotalCents, itemsDiscountCents, deliveryFeeCents, vatRate: settings.fiscalPolicy.vatRate });
      financials.chargeSnapshot.bandFeeCents = settings.bands.find(band => distance <= band.upToMeters).feeCents;
      financials.chargeSnapshot.freeDeliveryApplied = deliveryFeeOverrideCents === undefined
        && settings.freeDeliveryEnabled && financials.itemsNetCents >= settings.freeDeliveryThresholdCents;
      if (deliveryFeeOverrideCents !== undefined) financials.chargeSnapshot.manualFeeOverride = true;
      const expiresAt = new Date(new Date(now).getTime() + 300000).toISOString();
      const quote = { shopId, settingsRevision: settings.revision, addressSnapshot, distanceMeters: distance, ...financials, expiresAt,
        ...(deliveryFeeOverrideCents !== undefined && { suggestedFeeCents: suggestedFee }) };
      const quoteToken = tokenCodec.sign({ kind: "quote", ...quote, items: normalizedItems, discount: intent,
        ...(deliveryFeeOverrideCents !== undefined && { deliveryFeeOverrideCents }), issuedAt: new Date(now).toISOString() });
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
  };
};
module.exports = { normalizeQuoteItems, normalizeQuoteDiscount, buildDeliveryQuotes };
