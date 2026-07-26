const pool = require("../config/dbPool");
const { withTransaction } = require("../helpers/withTransaction");
const {
  getProductCustomizationState,
  getResolvedProductConfigurations,
  replaceProductConfiguration,
} = require("./m_customizations");

const queryRows = async (connection, sql, params) => {
  const [rows] = await connection.query(sql, params);
  return rows;
};

const projectLegacyCustomizations = (steps) => (steps || []).map((step) => ({
  name: step.name,
  description: step.description,
  limit_choice: step.maximum_choices,
  mandatory: step.minimum_choices > 0,
  items: (step.choices || [])
    .filter((choice) => choice.active !== false && choice.available !== false)
    .map((choice) => ({
      id: choice.product_step_choice_id,
      name: choice.name,
      price: Number(choice.extra_price),
    })),
}));

const minimumCommandablePrice = (price, steps, customizationAvailable) => {
  if (!customizationAvailable) return null;
  const minimumExtras = (steps || []).reduce((total, step) => {
    if (step.active === false || step.minimum_choices <= 0) return total;
    const availablePrices = (step.choices || [])
      .filter((choice) => choice.active !== false && choice.available !== false)
      .map((choice) => Number(choice.extra_price) || 0)
      .sort((left, right) => left - right);
    return total + availablePrices
      .slice(0, step.minimum_choices)
      .reduce((stepTotal, extraPrice) => stepTotal + extraPrice, 0);
  }, 0);
  return Number((Number(price) + minimumExtras).toFixed(2));
};

const productConfiguration = (configurations, productId) => (
  configurations.get(productId) || configurations.get(String(productId)) || []
);

const removeConfigurationAssociations = async (connection, productId) => {
  await queryRows(connection, `
    DELETE FROM product_customization_step_choices
    WHERE product_customization_step_id IN (
      SELECT id FROM product_customization_steps WHERE product_id = ?
    )
  `, [productId]);
  await queryRows(
    connection,
    "DELETE FROM product_customization_steps WHERE product_id = ?",
    [productId],
  );
};

const writeLegacyConfiguration = async ({
  connection,
  shopId,
  productId,
  customizations,
}) => {
  for (let stepIndex = 0; stepIndex < customizations.length; stepIndex += 1) {
    const customization = customizations[stepIndex];
    const items = Array.isArray(customization.items) ? customization.items : [];
    const requestedMaximum = Number(customization.limit_choice);
    const maximumChoices = Number.isInteger(requestedMaximum) && requestedMaximum > 0
      ? requestedMaximum
      : Math.max(items.length, 1);
    const stepResult = await queryRows(connection, `
      INSERT INTO customization_steps (
        shop_id, name, description, active, created, updated
      ) VALUES (?, ?, ?, 1, NOW(), NULL)
    `, [shopId, customization.name, customization.description || null]);
    const productStepResult = await queryRows(connection, `
      INSERT INTO product_customization_steps (
        product_id, step_id, position, minimum_choices, maximum_choices,
        active, created, updated
      ) VALUES (?, ?, ?, ?, ?, 1, NOW(), NULL)
    `, [
      productId,
      stepResult.insertId,
      stepIndex,
      customization.mandatory ? 1 : 0,
      maximumChoices,
    ]);

    for (let choiceIndex = 0; choiceIndex < items.length; choiceIndex += 1) {
      const item = items[choiceIndex];
      const choiceResult = await queryRows(connection, `
        INSERT INTO customization_step_choices (
          step_id, choice_type, name, image, linked_product_id,
          default_position, active, created, updated
        ) VALUES (?, 'simple', ?, NULL, NULL, ?, 1, NOW(), NULL)
      `, [stepResult.insertId, item.name, choiceIndex]);
      await queryRows(connection, `
        INSERT INTO product_customization_step_choices (
          product_customization_step_id, step_choice_id, extra_price,
          position, active
        ) VALUES (?, ?, ?, ?, 1)
      `, [
        productStepResult.insertId,
        choiceResult.insertId,
        Number(item.price) || 0,
        choiceIndex,
      ]);
    }
  }
};

const buildProductModule = ({
  connection = pool,
  withTransaction: runInTransaction = withTransaction,
  getResolvedProductConfigurations: resolveConfigurations = getResolvedProductConfigurations,
  getProductCustomizationState: resolveCustomizationState = getProductCustomizationState,
  replaceProductConfiguration: replaceConfiguration = replaceProductConfiguration,
} = {}) => {
  const formatProducts = async (products, shopId) => {
    const configurations = await resolveConfigurations({
      shopId,
      productIds: products.map(({ id }) => id),
      connection,
    });
    return products.map((product) => {
      const steps = productConfiguration(configurations, product.id);
      const state = resolveCustomizationState(steps);
      return {
        ...product,
        customization_steps: steps,
        product_customization: projectLegacyCustomizations(steps),
        customization_available: state.customization_available,
        customization_blocking: {
          product_step_id: state.product_step_id,
          reason: state.reason,
        },
        blocking_product_step_id: state.product_step_id,
        customization_unavailable_reason: state.reason,
        minimum_commandable_price: minimumCommandablePrice(
          product.price,
          steps,
          state.customization_available,
        ),
      };
    });
  };

  const mAllProduct = async (shopId) => {
    const products = await queryRows(connection, `
      SELECT products.*, category.name AS category, category.id AS categoryid
      FROM products
      LEFT JOIN category ON products.categoryId = category.id
      WHERE products.shopid = ?
    `, [shopId]);
    return formatProducts(products, shopId);
  };

  const mDetailProduct = async (id) => {
    const products = await queryRows(connection, `
      SELECT products.*, category.name AS category, category.id AS categoryid
      FROM products
      LEFT JOIN category ON products.categoryId = category.id
      WHERE products.id = ?
    `, [id]);
    if (products.length === 0) return [];
    return formatProducts(products, products[0].shopid);
  };

  const mAddProduct = (data) => runInTransaction(async (transactionConnection) => {
    const productData = { ...data };
    delete productData.customization_config;
    delete productData.product_customization;
    const result = await queryRows(
      transactionConnection,
      "INSERT INTO products SET ?",
      productData,
    );
    if (Object.prototype.hasOwnProperty.call(data, "customization_config")) {
      await replaceConfiguration({
        shopId: data.shopid,
        productId: result.insertId,
        steps: data.customization_config,
        connection: transactionConnection,
      });
    } else if (Object.prototype.hasOwnProperty.call(data, "product_customization")) {
      await writeLegacyConfiguration({
        connection: transactionConnection,
        shopId: data.shopid,
        productId: result.insertId,
        customizations: data.product_customization || [],
      });
    }
    return result;
  });

  const mUpdateProduct = (data, id) => runInTransaction(async (transactionConnection) => {
    const productData = { ...data };
    delete productData.customization_config;
    delete productData.product_customization;
    const result = await queryRows(
      transactionConnection,
      "UPDATE products SET ? WHERE id = ?",
      [productData, id],
    );
    if (Object.prototype.hasOwnProperty.call(data, "customization_config")) {
      const products = await queryRows(
        transactionConnection,
        "SELECT shopid FROM products WHERE id = ?",
        [id],
      );
      if (products.length > 0) {
        await replaceConfiguration({
          shopId: products[0].shopid,
          productId: id,
          steps: data.customization_config,
          connection: transactionConnection,
        });
      }
    } else if (Object.prototype.hasOwnProperty.call(data, "product_customization")) {
      const products = await queryRows(
        transactionConnection,
        "SELECT shopid FROM products WHERE id = ?",
        [id],
      );
      if (products.length > 0) {
        await removeConfigurationAssociations(transactionConnection, id);
        await writeLegacyConfiguration({
          connection: transactionConnection,
          shopId: products[0].shopid,
          productId: id,
          customizations: data.product_customization || [],
        });
      }
    }
    return result;
  });

  const mReplaceProductCustomizationConfig = ({ shopId, productId, steps }) => (
    replaceConfiguration({ shopId, productId, steps })
  );

  const mDeleteProduct = (id) => runInTransaction(async (transactionConnection) => {
    await removeConfigurationAssociations(transactionConnection, id);
    return queryRows(transactionConnection, "DELETE FROM products WHERE id = ?", [id]);
  });

  const mUsedProduct = async (id) => queryRows(
    connection,
    "SELECT COUNT(*) AS cnt FROM archivesdetail WHERE productid = ?",
    [id],
  );

  const mArchiveProduct = async (id) => queryRows(
    connection,
    "UPDATE products SET archived = 1 WHERE id = ?",
    [id],
  );

  return {
    mAddProduct,
    mAllProduct,
    mArchiveProduct,
    mDeleteProduct,
    mDetailProduct,
    mReplaceProductCustomizationConfig,
    mUpdateProduct,
    mUsedProduct,
  };
};

module.exports = {
  ...buildProductModule(),
  buildProductModule,
  minimumCommandablePrice,
  projectLegacyCustomizations,
};
