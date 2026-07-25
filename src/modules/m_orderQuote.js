const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");
const { validateConfiguredItem } = require("../helpers/customizationRules");
const { buildStockRequirements } = require("../helpers/stockRequirements");
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
    `SELECT id, shopid, name, price, stock, archived, is_hidden
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
  quoteOrderItems: async ({ shopId, items, connection }) => {
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
      return {
        ...item,
        product,
        steps,
        unitPrice,
        lineTotal,
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

module.exports = {
  buildOrderQuoteModule,
  quoteOrderItems: orderQuoteModule.quoteOrderItems,
};
