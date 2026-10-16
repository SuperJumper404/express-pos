const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");
const { buildVatSnapshot, resolveProductVatRate } = require("../helpers/vat");
const { validateConfiguredItem } = require("../helpers/customizationRules");
const { buildStockRequirements } = require("../helpers/stockRequirements");
const { toCents, fromCents, calculateDeliveryDiscount } = require("../helpers/deliveryMoney");
const {
  getResolvedProductConfigurations,
} = require("./m_customizations");

const cents = (value) => Math.round(Number(value) * 100);
const isUnavailable = (value) => value === true || value === 1 || value === "1";
const findById = (rows, id) => rows.find((row) => String(row.id) === String(id));
const findConfiguration = (configurations, productId) => configurations.get(productId)
  || configurations.get(String(productId))
  || [];

const queryResult = async (connection, sql, params = []) => {
  const [result] = await (connection || pool).query(sql, params);
  return result;
};

const sqlRepository = {
  getProducts: ({ shopId, productIds, connection }) => queryResult(
    connection,
    `SELECT id, shopid, name, price, vat_rate, vat_rate_dine_in, vat_rate_takeaway,
            stock, track_stock, stock_zero_behavior, archived, is_hidden
     FROM products
     WHERE shopid = ? AND id IN (?)
     ORDER BY id`,
    [shopId, productIds],
  ),
};

const buildOrderQuoteModule = ({
  repository = sqlRepository,
  getResolvedProductConfigurations: loadConfigurations = getResolvedProductConfigurations,
  validateConfiguredItem: validateItem = validateConfiguredItem,
  buildStockRequirements: stockRequirements = buildStockRequirements,
} = {}) => ({
  quoteOrderItems: async ({
    shopId,
    items,
    isTakeaway = false,
    connection,
  }) => {
    const parentProductIds = [...new Set(items.map((item) => Number(item.productId)))]
      .sort((left, right) => left - right);
    const products = await repository.getProducts({
      shopId,
      productIds: parentProductIds,
      connection,
    });
    if (products.length !== parentProductIds.length) {
      const missingIds = parentProductIds.filter((id) => !findById(products, id));
      throw new DomainError(404, "PRODUCT_NOT_FOUND", "Product not found", {
        product_ids: missingIds,
      });
    }
    for (const product of products) {
      if (isUnavailable(product.archived) || isUnavailable(product.is_hidden)) {
        throw new DomainError(422, "PRODUCT_UNAVAILABLE", "Product is unavailable", {
          product_id: product.id,
        });
      }
    }

    const configurations = await loadConfigurations({
      shopId,
      productIds: parentProductIds,
      connection,
    });
    const resolvedItems = items.map((item) => {
      const product = findById(products, item.productId);
      const steps = findConfiguration(configurations, item.productId);
      let validated;
      try {
        validated = validateItem({
          product,
          steps,
          selectedChoiceIds: item.selectedChoiceIds,
        });
      } catch (error) {
        if (error instanceof DomainError) error.product_id = item.productId;
        throw error;
      }
      const unitPrice = parseMoney(validated.unitPrice);
      const lineTotal = parseMoney(unitPrice * item.quantity);
      const vatSnapshot = buildVatSnapshot({
        unitPrice,
        quantity: item.quantity,
        vatRate: resolveProductVatRate(product, isTakeaway),
      });
      return {
        ...item,
        product,
        steps,
        unitPrice,
        lineTotal,
        ...vatSnapshot,
        selectedChoices: validated.selectedChoices,
      };
    });
    const total = parseMoney(
      resolvedItems.reduce((sum, item) => sum + cents(item.lineTotal), 0) / 100,
    );
    const serverQuote = {
      total,
      items: resolvedItems.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        selected_choice_ids: [...item.selectedChoiceIds].sort((a, b) => a - b),
        unit_price: item.unitPrice,
        total: item.lineTotal,
        vat_rate: item.vatRate,
        unit_price_ht: item.unitPriceHt,
        unit_vat: item.unitVat,
        total_ht: item.totalHt,
        total_vat: item.totalVat,
      })),
    };

    return {
      resolvedItems,
      total,
      serverQuote,
      requirements: stockRequirements(resolvedItems),
    };
  },
});

const orderQuoteModule = buildOrderQuoteModule();

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
};
const quoteIntent = quote => stable({
  settingsRevision: quote.settingsRevision, addressSnapshot: quote.addressSnapshot,
  distanceMeters: quote.distanceMeters, itemsTotalCents: quote.itemsTotalCents,
  itemsDiscountCents: quote.itemsDiscountCents, itemsNetCents: quote.itemsNetCents,
  deliveryFeeCents: quote.deliveryFeeCents, grandTotalCents: quote.grandTotalCents,
  chargeSnapshot: quote.chargeSnapshot,
});
const canonicalItems = items => items.map(item => ({
  productId: Number(item.productId), quantity: Number(item.quantity),
  selectedChoiceIds: [...item.selectedChoiceIds].map(Number).sort((a, b) => a - b),
})).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

const applyDeliveryDiscountToItems = (items, discountCents) => {
  const gross = items.reduce((sum, item) => sum + BigInt(toCents(item.lineTotal)), 0n);
  let cumulative = 0n;
  let allocated = 0n;
  return items.map(item => {
    const line = BigInt(toCents(item.lineTotal));
    cumulative += line;
    const target = gross === 0n ? 0n : (BigInt(discountCents) * cumulative + gross / 2n) / gross;
    const discount = target - allocated;
    allocated = target;
    const net = Number(line - discount);
    const divisor = BigInt(10000 + Math.round(item.vatRate * 100));
    const ht = Number((BigInt(net) * 10000n + divisor / 2n) / divisor);
    return {
      ...item, lineTotal: fromCents(net), discountedTotal: fromCents(net),
      discountAmount: fromCents(Number(discount)), totalHt: fromCents(ht), totalVat: fromCents(net - ht),
      unitPriceHt: Number((ht / 100 / item.quantity).toFixed(2)),
      unitVat: Number(((net - ht) / 100 / item.quantity).toFixed(2)),
    };
  });
};

// Both checkout and explicit amendments compare signed intent with current server pricing.
const quoteDeliveryOrder = async ({ checkout, connection, deliveryQuotes, quoteItems = orderQuoteModule.quoteOrderItems }) => {
  const signed = deliveryQuotes.validateQuoteToken(checkout.deliveryQuoteToken, { shopId: checkout.shopId, connection });
  const discount = { type: checkout.discountType, value: checkout.discountValue };
  const current = await deliveryQuotes.createQuote({
    shopId: checkout.shopId, items: checkout.items, discount,
    addressResolutionToken: checkout.addressResolutionToken, connection,
  });
  if (JSON.stringify(quoteIntent(signed)) !== JSON.stringify(quoteIntent(current))
    || JSON.stringify(canonicalItems(signed.items)) !== JSON.stringify(canonicalItems(checkout.items))
    || JSON.stringify(stable(signed.discount)) !== JSON.stringify(stable(discount))
    || toCents(checkout.expectedTotal) !== current.grandTotalCents) {
    throw new DomainError(409, "DELIVERY_QUOTE_CHANGED", "Delivery quote must be reconfirmed", { server_quote: current });
  }
  const itemQuote = await quoteItems({ shopId: checkout.shopId, items: checkout.items, isTakeaway: true, connection });
  const integerDiscount = calculateDeliveryDiscount({ itemsTotalCents: toCents(itemQuote.total), ...discount });
  if (toCents(itemQuote.total) !== current.itemsTotalCents || integerDiscount.itemsDiscountCents !== current.itemsDiscountCents) {
    throw new DomainError(409, "DELIVERY_QUOTE_CHANGED", "Delivery quote must be reconfirmed");
  }
  return {
    ...itemQuote, total: fromCents(current.grandTotalCents), deliveryQuote: current,
    resolvedItems: applyDeliveryDiscountToItems(itemQuote.resolvedItems, integerDiscount.itemsDiscountCents),
    discount: { ...discount, amount: fromCents(integerDiscount.itemsDiscountCents), total: fromCents(current.grandTotalCents) },
  };
};

module.exports = {
  buildOrderQuoteModule,
  quoteOrderItems: orderQuoteModule.quoteOrderItems,
  quoteDeliveryOrder,
};
