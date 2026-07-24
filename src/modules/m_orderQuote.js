const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");
const { validateConfiguredItem } = require("../helpers/customizationRules");
const { buildStockRequirements } = require("../helpers/stockRequirements");
const {
  getResolvedProductConfigurations,
} = require("./m_customizations");

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

const unavailable = (value) => [true, 1, "1", "true"].includes(value);
const byId = (rows, id) => rows.find((row) => Number(row.id) === Number(id));

const buildOrderQuoteModule = ({
  repository = sqlRepository,
  getResolvedProductConfigurations: loadConfigurations = (
    getResolvedProductConfigurations
  ),
  validateConfiguredItem: validateItem = validateConfiguredItem,
  buildStockRequirements: stockRequirements = buildStockRequirements,
} = {}) => {
  const quoteOrderItems = async ({ shopId, items, connection }) => {
    const productIds = [...new Set(items.map((item) => Number(item.productId)))].sort(
      (left, right) => left - right,
    );
    const products = await repository.getProducts({ shopId, productIds, connection });
    if (products.length !== productIds.length) {
      throw new DomainError(404, "PRODUCT_NOT_FOUND", "Product not found", {
        product_ids: productIds.filter((id) => !byId(products, id)),
      });
    }
    for (const product of products) {
      if (unavailable(product.archived) || unavailable(product.is_hidden)) {
        throw new DomainError(422, "PRODUCT_UNAVAILABLE", "Product is unavailable", {
          product_id: product.id,
        });
      }
    }

    const configurations = await loadConfigurations({
      shopId,
      productIds,
      connection,
    });
    const resolvedItems = items.map((item) => {
      const product = byId(products, item.productId);
      const steps = configurations.get(Number(item.productId))
        || configurations.get(String(item.productId))
        || [];
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
      const lineTotal = parseMoney(unitPrice * Number(item.quantity));
      return {
        ...item,
        product,
        steps,
        selectedChoices: validated.selectedChoices,
        unitPrice,
        lineTotal,
      };
    });
    const total = parseMoney(
      resolvedItems.reduce((sum, item) => sum + item.lineTotal, 0),
    );
    const serverQuote = {
      total,
      items: resolvedItems.map((item) => ({
        product_id: item.productId,
        quantity: item.quantity,
        selected_product_step_choice_ids: [...item.selectedChoiceIds].sort(
          (left, right) => left - right,
        ),
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
  };

  return { quoteOrderItems };
};

const orderQuoteModule = buildOrderQuoteModule();

module.exports = {
  buildOrderQuoteModule,
  quoteOrderItems: orderQuoteModule.quoteOrderItems,
};
