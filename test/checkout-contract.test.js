const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const {
  buildCheckoutModule,
  buildCheckoutController,
  canonicalPayloadHash,
} = require("../src/modules/m_checkout");
const { buildOrderQuoteModule } = require("../src/modules/m_orderQuote");

const routerSource = fs.readFileSync(
  require.resolve("../src/routers/r_customizations"),
  "utf8",
);
const productRouterSource = fs.readFileSync(
  require.resolve("../src/routers/r_products"),
  "utf8",
);
const uploadSource = fs.readFileSync(
  require.resolve("../src/helpers/middleware/customizationChoiceImages"),
  "utf8",
);
const indexSource = fs.readFileSync(require.resolve("../index"), "utf8");
for (const route of [
  '"/customization-steps"',
  '"/customization-steps/:id"',
  '"/customization-steps/:id/choices"',
  '"/customization-choices/:id"',
]) assert.ok(routerSource.includes(route), route);
for (const policy of [
  "5 * 1024 * 1024",
  '"image/jpeg"',
  '"image/png"',
  '"image/webp"',
]) assert.ok(uploadSource.includes(policy), policy);
assert.ok(uploadSource.includes("randomBytes"));
assert.ok(!uploadSource.includes("originalname"));
for (const protectedRead of [
  /\.get\("\/customization-steps", authentication,/,
  /\.get\("\/customization-steps\/:id", authentication,/,
]) assert.match(routerSource, protectedRead);
for (const adminWrite of [
  /\.post\("\/customization-steps", authentication, authAdmin,/,
  /\.patch\("\/customization-steps\/:id", authentication, authAdmin,/,
  /\.delete\("\/customization-steps\/:id", authentication, authAdmin,/,
  /\.post\([\s\S]*"\/customization-steps\/:id\/choices",[\s\S]*authentication,[\s\S]*authAdmin,/,
  /\.patch\([\s\S]*"\/customization-choices\/:id",[\s\S]*authentication,[\s\S]*authAdmin,/,
  /\.delete\("\/customization-choices\/:id", authentication, authAdmin,/,
]) assert.match(routerSource, adminWrite);
assert.ok(indexSource.includes('require("./src/routers/r_customizations")'));
assert.ok(indexSource.includes('path.join(envPUBLICIMAGEPATH, "customization-choices")'));
assert.ok(indexSource.includes('app.use(`${prefix}`, routerCustomizations)'));
assert.match(
  productRouterSource,
  /\.put\(["']\/products\/:id\/customization-config["'], authentication, authAdmin,/,
);
assert.match(
  indexSource,
  /"\/api\/v1\/imgcustomizations"[\s\S]*express\.static\(customizationChoicesPath\)/,
);
const {
  createCustomizationChoice,
  createCustomizationStep,
  deleteCustomizationChoice,
  deleteCustomizationStep,
  getCustomizationStep,
  getProductCustomizationState,
  groupResolvedConfigurationRows,
  getResolvedProductConfigurations,
  listCustomizationSteps,
  replaceProductConfiguration,
  updateCustomizationChoice,
  updateCustomizationStep,
} = require("../src/modules/m_customizations");
const { buildCustomizationController } = require("../src/controllers/c_customizations");
const { buildProductController } = require("../src/controllers/c_products");
const DomainError = require("../src/helpers/domainError");
const {
  buildProductModule,
  projectLegacyCustomizations,
} = require("../src/modules/m_products");
const {
  buildCustomizationChoiceImageUpload,
} = require("../src/helpers/middleware/customizationChoiceImages");
const callbackDbPath = require.resolve("../src/config/db");
require.cache[callbackDbPath] = {
  exports: { query: () => { throw new Error("unexpected legacy DB query"); } },
};
const { buildOrderArchiveModule } = require("../src/modules/m_orders");

assert.deepStrictEqual(projectLegacyCustomizations([{
  product_step_id: 10,
  name: "Boissons",
  description: "Choisissez",
  minimum_choices: 1,
  maximum_choices: 1,
  choices: [{
    product_step_choice_id: 30,
    name: "Cola",
    extra_price: "0.50",
    active: true,
    available: true,
  }],
}]), [{
  name: "Boissons",
  description: "Choisissez",
  limit_choice: 1,
  mandatory: true,
  items: [{ id: 30, name: "Cola", price: 0.5 }],
}]);
assert.strictEqual(typeof buildProductModule, "function");
assert.strictEqual(typeof buildProductController, "function");

const runProductReadContracts = async () => {
  const productQueries = [];
  const resolvedCalls = [];
  const stateCalls = [];
  const productModule = buildProductModule({
    connection: {
      query: async (sql, params) => {
        productQueries.push({ sql, params });
        return [[
          {
            id: 1,
            name: "Menu",
            shopid: 7,
            description: "Formule",
            category: "Menus",
            categoryid: 3,
            price: "10.00",
            stock: 5,
            image: "menu.webp",
            archived: 0,
            is_hidden: 0,
          },
          {
            id: 2,
            name: "Menu indisponible",
            shopid: 7,
            description: "Formule",
            category: "Menus",
            categoryid: 3,
            price: "8.00",
            stock: 5,
            image: "menu-2.webp",
            archived: 0,
            is_hidden: 0,
          },
        ]];
      },
    },
    getResolvedProductConfigurations: async ({ shopId, productIds, connection }) => {
      resolvedCalls.push({ shopId, productIds, connection });
      return new Map([
        [1, [{
          product_step_id: 10,
          name: "Boissons",
          description: "Choisissez",
          minimum_choices: 1,
          maximum_choices: 2,
          active: true,
          choices: [
            {
              product_step_choice_id: 30,
              name: "Cola",
              extra_price: "1.00",
              active: true,
              available: true,
            },
            {
              product_step_choice_id: 31,
              name: "Rupture",
              extra_price: "0.10",
              active: true,
              available: false,
            },
          ],
        }]],
        [2, [{ product_step_id: 20, choices: [] }]],
      ]);
    },
    getProductCustomizationState: (steps) => {
      stateCalls.push(steps);
      return steps[0].product_step_id === 20
        ? {
          customization_available: false,
          product_step_id: 20,
          reason: { code: "INSUFFICIENT_AVAILABLE_CHOICES" },
        }
        : { customization_available: true, product_step_id: null, reason: null };
    },
  });

  const products = await productModule.mAllProduct(7);
  assert.strictEqual(productQueries.length, 1, "one products query");
  assert.match(productQueries[0].sql, /FROM products/);
  assert.deepStrictEqual(productQueries[0].params, [7]);
  assert.strictEqual(resolvedCalls.length, 1, "one resolved-configuration query");
  assert.deepStrictEqual(resolvedCalls[0].productIds, [1, 2]);
  assert.strictEqual(stateCalls.length, 2, "state helper is consumed for each product");
  assert.strictEqual(products[0].customization_steps.length, 1);
  assert.deepStrictEqual(products[0].product_customization, [{
    name: "Boissons",
    description: "Choisissez",
    limit_choice: 2,
    mandatory: true,
    items: [{ id: 30, name: "Cola", price: 1 }],
  }]);
  assert.strictEqual(products[0].customization_available, true);
  assert.strictEqual(products[0].minimum_commandable_price, 11);
  assert.deepStrictEqual(products[1].customization_blocking, {
    product_step_id: 20,
    reason: { code: "INSUFFICIENT_AVAILABLE_CHOICES" },
  });
  assert.strictEqual(products[1].minimum_commandable_price, null);

  const detailQueries = [];
  const detailResolvedCalls = [];
  const detailModule = buildProductModule({
    connection: {
      query: async (sql, params) => {
        detailQueries.push({ sql, params });
        return [[{
          id: 1,
          name: "Menu",
          shopid: 7,
          price: "10.00",
        }]];
      },
    },
    getResolvedProductConfigurations: async (options) => {
      detailResolvedCalls.push(options);
      return new Map([[1, []]]);
    },
    getProductCustomizationState: () => ({
      customization_available: true,
      product_step_id: null,
      reason: null,
    }),
  });
  const detail = await detailModule.mDetailProduct(1);
  assert.strictEqual(detailQueries.length, 1, "one detail product query");
  assert.deepStrictEqual(detailQueries[0].params, [1]);
  assert.strictEqual(detailResolvedCalls.length, 1, "one detail configuration batch");
  assert.deepStrictEqual(detailResolvedCalls[0].productIds, [1]);
  assert.deepStrictEqual(detail[0].customization_steps, []);
  assert.deepStrictEqual(detail[0].product_customization, []);
  assert.strictEqual(detail[0].minimum_commandable_price, 10);
};

const runProductWriteContracts = async () => {
  const transactionEvents = [];
  const writeCalls = [];
  const replaceCalls = [];
  const transactionConnection = {
    query: async (sql, params) => {
      writeCalls.push({ sql, params });
      if (/INSERT INTO products/.test(sql)) return [{ insertId: 100 }];
      if (/INSERT INTO customization_steps/.test(sql)) return [{ insertId: 200 }];
      if (/INSERT INTO product_customization_steps/.test(sql)) return [{ insertId: 300 }];
      if (/INSERT INTO customization_step_choices/.test(sql)) return [{ insertId: 400 }];
      if (/SELECT shopid FROM products/.test(sql)) return [[{ shopid: 7 }]];
      return [{ affectedRows: 1 }];
    },
  };
  const productModule = buildProductModule({
    withTransaction: async (work) => {
      transactionEvents.push("begin");
      try {
        const result = await work(transactionConnection);
        transactionEvents.push("commit");
        return result;
      } catch (error) {
        transactionEvents.push("rollback");
        throw error;
      }
    },
    replaceProductConfiguration: async (options) => {
      replaceCalls.push(options);
      return true;
    },
  });

  await productModule.mAddProduct({
    name: "Menu legacy",
    shopid: 7,
    categoryid: 3,
    price: 10,
    stock: 5,
    image: "menu.webp",
    product_customization: [{
      name: "Boissons",
      description: "Choisissez",
      mandatory: true,
      limit_choice: 1,
      items: [{ name: "Cola", price: 0.5 }],
    }],
  });
  assert.deepStrictEqual(transactionEvents, ["begin", "commit"]);
  assert.ok(writeCalls.some(({ sql }) => /INSERT INTO customization_steps/.test(sql)));
  assert.ok(writeCalls.some(({ sql }) => /INSERT INTO product_customization_steps/.test(sql)));
  assert.ok(writeCalls.some(({ sql }) => /INSERT INTO customization_step_choices/.test(sql)));
  assert.ok(writeCalls.some(({ sql }) => /INSERT INTO product_customization_step_choices/.test(sql)));
  assert.ok(!writeCalls.some(({ sql }) => /\bproduct_customization\b/.test(sql)));
  assert.ok(!writeCalls.some(({ sql }) => /\bproduct_choice\b/.test(sql)));

  transactionEvents.length = 0;
  writeCalls.length = 0;
  const canonicalConfig = [{
    step_id: 20,
    minimum_choices: 0,
    maximum_choices: 1,
    choices: [],
  }];
  await productModule.mAddProduct({
    name: "Menu V2",
    shopid: 7,
    categoryid: 3,
    price: 10,
    stock: 5,
    image: "menu-v2.webp",
    customization_config: canonicalConfig,
  });
  assert.deepStrictEqual(transactionEvents, ["begin", "commit"]);
  assert.strictEqual(replaceCalls.length, 1);
  assert.strictEqual(replaceCalls[0].connection, transactionConnection);
  assert.strictEqual(replaceCalls[0].productId, 100);
  assert.strictEqual(replaceCalls[0].shopId, 7);
  assert.strictEqual(replaceCalls[0].steps, canonicalConfig);

  transactionEvents.length = 0;
  writeCalls.length = 0;
  await productModule.mUpdateProduct({
    product_customization: [],
    updated: "now",
  }, 100);
  assert.deepStrictEqual(transactionEvents, ["begin", "commit"]);
  assert.ok(writeCalls.some(({ sql }) => /UPDATE products/.test(sql)));
  assert.ok(writeCalls.some(({ sql }) => /DELETE FROM product_customization_step_choices/.test(sql)));
  assert.ok(writeCalls.some(({ sql }) => /DELETE FROM product_customization_steps/.test(sql)));
  assert.ok(!writeCalls.some(({ sql }) => /DELETE FROM product_customization\s/.test(sql)));
  assert.ok(!writeCalls.some(({ sql }) => /\bproduct_choice\b/.test(sql)));

  const rollbackEvents = [];
  const failingModule = buildProductModule({
    withTransaction: async (work) => {
      rollbackEvents.push("begin");
      try {
        await work(transactionConnection);
        rollbackEvents.push("commit");
      } catch (error) {
        rollbackEvents.push("rollback");
        throw error;
      }
    },
    replaceProductConfiguration: async () => {
      throw new Error("configuration insert failed");
    },
  });
  await assert.rejects(
    () => failingModule.mAddProduct({
      name: "Rollback",
      shopid: 7,
      customization_config: canonicalConfig,
    }),
    /configuration insert failed/,
  );
  assert.deepStrictEqual(rollbackEvents, ["begin", "rollback"]);
};

const productResponse = () => ({
  statusCode: null,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const runProductControllerContracts = async () => {
  const replaceCalls = [];
  let handlers = buildProductController({
    products: {
      mReplaceProductCustomizationConfig: async (options) => {
        replaceCalls.push(options);
        return true;
      },
    },
  });
  let res = productResponse();
  const steps = [{
    step_id: 20,
    minimum_choices: 0,
    maximum_choices: 1,
    choices: [],
  }];
  await handlers.updateProductCustomizationConfig({
    shopid: 7,
    params: { id: "100" },
    body: { customization_config: JSON.stringify(steps) },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(replaceCalls, [{ shopId: 7, productId: "100", steps }]);

  handlers = buildProductController({
    products: {
      mReplaceProductCustomizationConfig: async () => {
        throw new DomainError(
          422,
          "CUSTOMIZATION_STEP_NOT_OWNED",
          "Customization step does not belong to this shop",
          { product_id: 100, step_id: 20 },
        );
      },
    },
  });
  res = productResponse();
  await handlers.updateProductCustomizationConfig({
    shopid: 7,
    params: { id: "100" },
    body: { steps },
  }, res);
  assert.strictEqual(res.statusCode, 422);
  assert.deepStrictEqual(res.payload.data, {
    code: "CUSTOMIZATION_STEP_NOT_OWNED",
    product_id: 100,
    product_step_id: 20,
    choice_id: null,
  });

  const removedFiles = [];
  handlers = buildProductController({
    products: {
      mAddProduct: async () => {
        throw new Error("insert failed");
      },
    },
    fileSystem: {
      existsSync: () => true,
      unlinkSync: (filename) => removedFiles.push(filename),
    },
    publicImagePath: "C:\\public-images",
    logger: { error: () => {} },
  });
  res = productResponse();
  await handlers.addProduct({
    shopid: 7,
    file: { filename: "new.webp" },
    body: {
      name: "Menu",
      categoryid: 3,
      price: "10.00",
      stock: 5,
      customization_config: "[]",
    },
  }, res);
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(removedFiles, [
    path.join("C:\\public-images", "products", "new.webp"),
  ]);

  removedFiles.length = 0;
  handlers = buildProductController({
    products: {
      mDetailProduct: async () => [{ image: "old.webp" }],
      mUpdateProduct: async () => {
        throw new Error("update failed");
      },
    },
    fileSystem: {
      existsSync: () => true,
      unlinkSync: (filename) => removedFiles.push(filename),
    },
    publicImagePath: "C:\\public-images",
    logger: { error: () => {} },
  });
  res = productResponse();
  await handlers.updateProduct({
    params: { id: "100" },
    file: { filename: "replacement.webp" },
    body: {},
  }, res);
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(removedFiles, [
    path.join("C:\\public-images", "products", "replacement.webp"),
  ]);

  removedFiles.length = 0;
  handlers = buildProductController({
    products: {
      mDetailProduct: async () => [{ image: "old.webp" }],
      mUpdateProduct: async () => true,
    },
    fileSystem: {
      existsSync: () => true,
      unlinkSync: (filename) => removedFiles.push(filename),
    },
    publicImagePath: "C:\\public-images",
  });
  res = productResponse();
  await handlers.updateProduct({
    params: { id: "100" },
    file: { filename: "replacement.webp" },
    body: {},
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(removedFiles, [
    path.join("C:\\public-images", "products", "old.webp"),
  ]);
};

const grouped = groupResolvedConfigurationRows([{
  product_id: 1,
  product_step_id: 10,
  step_id: 20,
  step_name: "Boissons",
  minimum_choices: 1,
  maximum_choices: 1,
  step_position: 2,
  product_step_choice_id: 30,
  step_choice_id: 40,
  choice_type: "simple",
  simple_name: "Eau",
  simple_image: "eau.webp",
  linked_name: null,
  linked_image: null,
  linked_stock: null,
  linked_archived: null,
  extra_price: "0.50",
  choice_position: 1,
  choice_active: 1,
}]);

assert.strictEqual(grouped.get(1)[0].choices[0].name, "Eau");
assert.strictEqual(grouped.get(1)[0].choices[0].available, true);

const unavailable = groupResolvedConfigurationRows([
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 31,
    step_choice_id: 41,
    choice_type: "linked_product",
    linked_product_id: 3,
    linked_name: "Frites",
    linked_image: "frites.webp",
    linked_stock: "5",
    linked_archived: "0",
    linked_is_hidden: 1,
    extra_price: "1.00",
    choice_position: 2,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 32,
    step_choice_id: 42,
    choice_type: "linked_product",
    linked_product_id: 4,
    linked_name: "Salade",
    linked_image: "salade.webp",
    linked_stock: 0,
    linked_archived: 0,
    linked_is_hidden: 0,
    extra_price: "0.00",
    choice_position: 1,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 33,
    step_choice_id: 43,
    choice_type: "linked_product",
    linked_product_id: 5,
    linked_name: "Potatoes",
    linked_image: "potatoes.webp",
    linked_stock: 5,
    linked_archived: 1,
    linked_is_hidden: 0,
    extra_price: "0.00",
    choice_position: 3,
    product_step_choice_active: 1,
    choice_active: 1,
  },
  {
    product_id: 2,
    product_step_id: 11,
    step_id: 21,
    step_name: "Accompagnements",
    minimum_choices: 2,
    maximum_choices: 2,
    step_position: 1,
    product_step_active: 1,
    step_active: 1,
    product_step_choice_id: 34,
    step_choice_id: 44,
    choice_type: "simple",
    simple_name: "Sans accompagnement",
    simple_image: null,
    extra_price: "0.00",
    choice_position: 4,
    product_step_choice_active: 0,
    choice_active: 1,
  },
]);
const unavailableSteps = unavailable.get(2);
assert.strictEqual(unavailableSteps[0].choices[1].name, "Frites");
assert.strictEqual(unavailableSteps[0].choices[1].available, true);
assert.strictEqual(
  unavailableSteps[0].choices.find((choice) => choice.product_step_choice_id === 33).available,
  false,
);
assert.strictEqual(
  unavailableSteps[0].choices.find((choice) => choice.product_step_choice_id === 34).available,
  false,
);
assert.strictEqual(unavailableSteps[0].available_choice_count, 1);
assert.strictEqual(unavailableSteps[0].available, false);
assert.strictEqual(unavailableSteps.customization_available, false);
assert.strictEqual(unavailableSteps.blocking_product_step_id, 11);
assert.deepStrictEqual(unavailableSteps.unavailable_reason, {
  code: "INSUFFICIENT_AVAILABLE_CHOICES",
  available_choice_count: 1,
  minimum_choices: 2,
});
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(getProductCustomizationState(unavailableSteps))),
  {
    customization_available: false,
    product_step_id: 11,
    reason: {
      code: "INSUFFICIENT_AVAILABLE_CHOICES",
      available_choice_count: 1,
      minimum_choices: 2,
    },
  },
);

const runRepositoryReadContracts = async () => {
  const resolvedCalls = [];
  const resolvedConnection = {
    query: async (sql, params) => {
      resolvedCalls.push({ sql, params });
      return [[{
        product_id: 8,
        product_step_id: 80,
        step_id: 81,
        step_name: "Sauces",
        minimum_choices: 0,
        maximum_choices: 2,
        step_position: 1,
        product_step_choice_id: null,
      }]];
    },
  };
  const resolved = await getResolvedProductConfigurations({
    shopId: 7,
    productIds: ["8", "9", 8],
    connection: resolvedConnection,
  });
  assert.strictEqual(resolvedCalls.length, 1);
  assert.match(resolvedCalls[0].sql, /p\.id IN \(\?\)/);
  assert.match(resolvedCalls[0].sql, /LEFT JOIN customization_step_choices/);
  assert.match(resolvedCalls[0].sql, /LEFT JOIN products linked_product/);
  assert.deepStrictEqual(resolvedCalls[0].params, [7, ["8", "9"]]);
  assert.strictEqual(resolved.get("8")[0].name, "Sauces");
  assert.ok(!resolved.has(8));
  assert.deepStrictEqual(resolved.get("9"), []);
  assert.strictEqual(resolved.get("9").customization_available, true);

  const listCalls = [];
  const listed = await listCustomizationSteps(7, {
    query: async (sql, params) => {
      listCalls.push({ sql, params });
      return [[
        {
          step_id: 5,
          step_name: "Boissons",
          step_description: "Choisissez",
          step_active: 1,
          step_created: "created",
          step_updated: null,
          choice_id: 51,
          choice_type: "simple",
          simple_name: "Eau",
          simple_image: "eau.webp",
          linked_product_id: null,
          default_position: 2,
          choice_active: 1,
        },
      ]];
    },
  });
  assert.strictEqual(listCalls.length, 1);
  assert.deepStrictEqual(listCalls[0].params, [7]);
  assert.strictEqual(listed[0].choices[0].name, "Eau");

  const replacementCalls = [];
  const replacementConnection = {
    query: async (sql, params) => {
      replacementCalls.push({ sql, params });
      if (/SELECT p\.id[\s\S]*FROM products p/.test(sql)) return [[{ id: 100 }]];
      if (/SELECT step\.id[\s\S]*FROM customization_steps step/.test(sql)) {
        return [[{ id: 20 }]];
      }
      if (/SELECT[\s\S]*choice\.id[\s\S]*FROM customization_step_choices choice/.test(sql)) {
        return [[{
          id: 40,
          step_id: 20,
          choice_type: "simple",
          linked_product_id: null,
          linked_shop_id: null,
        }]];
      }
      if (/INSERT INTO product_customization_steps/.test(sql)) {
        return [{ insertId: 200 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
  await replaceProductConfiguration({
    shopId: 7,
    productId: 100,
    steps: [{
      step_id: 20,
      position: 1,
      minimum_choices: 1,
      maximum_choices: 1,
      active: true,
      choices: [{
        step_choice_id: 40,
        extra_price: "0.50",
        position: 1,
        active: true,
      }],
    }],
    connection: replacementConnection,
  });
  const firstDelete = replacementCalls.findIndex(({ sql }) => /DELETE FROM/.test(sql));
  assert.ok(firstDelete >= 3, "all ownership reads happen before replacement");
  assert.ok(replacementCalls.some(({ sql }) => (
    /FROM customization_steps step/.test(sql) && /FOR UPDATE/.test(sql)
  )), "product configuration locks referenced steps against concurrent deletion");
  assert.match(replacementCalls[firstDelete].sql, /product_customization_step_choices/);
  assert.ok(replacementCalls.some(({ sql, params }) => (
    /INSERT INTO product_customization_step_choices/.test(sql)
      && params[1] === 40
  )));

  const baseStep = {
    step_id: 20,
    minimum_choices: 1,
    maximum_choices: 1,
    choices: [{ step_choice_id: 40 }],
  };
  const nullStepIdCalls = [];
  const nullStepIdConnection = {
    query: async (sql) => {
      nullStepIdCalls.push(sql);
      if (/FROM products p/.test(sql)) return [[{ id: 100 }]];
      if (/FROM customization_steps step/.test(sql)) return [[{ id: 20 }]];
      if (/INSERT INTO product_customization_steps/.test(sql)) return [{ insertId: 200 }];
      return [{ affectedRows: 1 }];
    },
  };
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [{
        step_id: null,
        minimum_choices: 0,
        maximum_choices: 1,
        choices: [],
      }],
      connection: nullStepIdConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_STEP_ID_INVALID"
      && Object.prototype.hasOwnProperty.call(error, "step_id")
      && error.step_id === null,
  );
  assert.ok(!nullStepIdCalls.some((sql) => /DELETE FROM/.test(sql)));
  const nullChoiceIdCalls = [];
  const nullChoiceIdConnection = {
    query: async (sql) => {
      nullChoiceIdCalls.push(sql);
      if (/FROM products p/.test(sql)) return [[{ id: 100 }]];
      if (/FROM customization_steps step/.test(sql)) return [[{ id: 20 }]];
      if (/FROM customization_step_choices choice/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [{
        step_id: 20,
        minimum_choices: 0,
        maximum_choices: 1,
        choices: [{ step_choice_id: null }],
      }],
      connection: nullChoiceIdConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_CHOICE_ID_INVALID"
      && Object.prototype.hasOwnProperty.call(error, "choice_id")
      && error.choice_id === null
      && error.step_id === 20,
  );
  assert.ok(!nullChoiceIdCalls.some((sql) => /DELETE FROM/.test(sql)));
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep, { ...baseStep, choices: [] }],
      connection: replacementConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_STEP_DUPLICATE",
  );
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [{ ...baseStep, choices: [{ step_choice_id: 40 }, { step_choice_id: 40 }] }],
      connection: replacementConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_CHOICE_DUPLICATE",
  );
  for (const invalidLimits of [
    { minimum_choices: -1, maximum_choices: 1 },
    { minimum_choices: 0, maximum_choices: 0 },
    { minimum_choices: 2, maximum_choices: 1 },
  ]) {
    await assert.rejects(
      () => replaceProductConfiguration({
        shopId: 7,
        productId: 100,
        steps: [{ ...baseStep, ...invalidLimits }],
        connection: replacementConnection,
      }),
      (error) => error.code === "CUSTOMIZATION_LIMITS_INVALID",
    );
  }

  const ownershipConnection = ({ stepRows, choiceRows }) => {
    const calls = [];
    return {
      calls,
      query: async (sql) => {
        calls.push(sql);
        if (/FROM products p/.test(sql)) return [[{ id: 100 }]];
        if (/FROM customization_steps step/.test(sql)) return [stepRows];
        if (/FROM customization_step_choices choice/.test(sql)) return [choiceRows];
        throw new Error("replacement mutated before full validation");
      },
    };
  };
  const foreignStepConnection = ownershipConnection({ stepRows: [], choiceRows: [] });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: foreignStepConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_STEP_NOT_OWNED",
  );
  assert.ok(!foreignStepConnection.calls.some((sql) => /DELETE FROM/.test(sql)));

  const wrongStepConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 99,
      choice_type: "simple",
      linked_product_id: null,
      linked_shop_id: null,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: wrongStepConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_CHOICE_STEP_MISMATCH",
  );

  const selfLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 100,
      linked_shop_id: 7,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: selfLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_PARENT_SELF_LINK",
  );
  assert.ok(!selfLinkConnection.calls.some((sql) => /DELETE FROM/.test(sql)));

  const stringSelfLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 100,
      linked_shop_id: 7,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: "7",
      productId: "100",
      steps: [{
        ...baseStep,
        step_id: "20",
        choices: [{ step_choice_id: "40" }],
      }],
      connection: stringSelfLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_PARENT_SELF_LINK",
  );

  const foreignLinkConnection = ownershipConnection({
    stepRows: [{ id: 20 }],
    choiceRows: [{
      id: 40,
      step_id: 20,
      choice_type: "linked_product",
      linked_product_id: 200,
      linked_shop_id: 8,
    }],
  });
  await assert.rejects(
    () => replaceProductConfiguration({
      shopId: 7,
      productId: 100,
      steps: [baseStep],
      connection: foreignLinkConnection,
    }),
    (error) => error.code === "CUSTOMIZATION_LINKED_PRODUCT_NOT_OWNED",
  );

  const crudCalls = [];
  const crudConnection = {
    query: async (sql, params) => {
      crudCalls.push({ sql, params });
      if (/SELECT[\s\S]*FROM customization_steps step[\s\S]*step\.id = \?/.test(sql)) {
        return [[{
          step_id: 20,
          step_name: "Boissons",
          step_description: null,
          step_active: 1,
          choice_id: null,
        }]];
      }
      if (/SELECT[\s\S]*FROM customization_step_choices choice/.test(sql)) {
        return [[{
          id: 40,
          step_id: 20,
          choice_type: "simple",
          name: "Eau",
          image: "old.webp",
          linked_product_id: null,
          default_position: 1,
          active: 1,
        }]];
      }
      if (/SELECT step\.id FROM customization_steps step/.test(sql)) return [[{ id: 20 }]];
      if (/INSERT INTO customization_steps/.test(sql)) return [{ insertId: 20 }];
      if (/INSERT INTO customization_step_choices/.test(sql)) return [{ insertId: 40 }];
      return [{ affectedRows: 1 }];
    },
  };
  assert.strictEqual((await getCustomizationStep({
    shopId: 7,
    stepId: 20,
    connection: crudConnection,
  })).name, "Boissons");
  assert.strictEqual((await createCustomizationStep({
    shopId: 7,
    data: { name: "Desserts", description: "Optionnel", active: "false" },
    connection: crudConnection,
  })).insertId, 20);
  await updateCustomizationStep({
    shopId: 7,
    stepId: 20,
    data: { name: "Boissons froides", active: "false" },
    connection: crudConnection,
  });
  const deleteStepCallStart = crudCalls.length;
  const deletedStep = await deleteCustomizationStep({
    shopId: 7,
    stepId: 20,
    connection: crudConnection,
  });
  const deleteStepCalls = crudCalls.slice(deleteStepCallStart);
  assert.deepStrictEqual(deletedStep, { affectedRows: 1, images: ["old.webp"] });
  assert.ok(deleteStepCalls.some(({ sql }) => (
    /FROM customization_steps step/.test(sql) && /FOR UPDATE/.test(sql)
  )), "step deletion locks the owned step before removing mappings");
  assert.deepStrictEqual(
    deleteStepCalls
      .filter(({ sql }) => /^\s*DELETE/i.test(sql))
      .map(({ sql }) => sql.match(/DELETE(?:\s+\w+)?\s+FROM\s+(\w+)/i)[1]),
    [
      "product_customization_step_choices",
      "product_customization_steps",
      "customization_step_choices",
      "customization_steps",
    ],
  );
  assert.ok(deleteStepCalls.every(({ sql }) => !/snapshot/i.test(sql)));
  assert.strictEqual((await createCustomizationChoice({
    shopId: 7,
    stepId: 20,
    data: {
      choice_type: "simple",
      name: "Eau",
      image: "eau.webp",
      default_position: 1,
      active: "false",
    },
    connection: crudConnection,
  })).insertId, 40);
  await updateCustomizationChoice({
    shopId: 7,
    choiceId: 40,
    data: { name: "Eau plate", image: "eau-plate.webp", active: "false" },
    connection: crudConnection,
  });
  await deleteCustomizationChoice({ shopId: 7, choiceId: 40, connection: crudConnection });
  assert.ok(crudCalls.every(({ sql }) => !/\$\{|shopId|stepId|choiceId/.test(sql)));
  assert.ok(crudCalls.some(({ sql, params }) => (
    /UPDATE customization_steps/.test(sql) && params.includes(7)
  )));
  assert.ok(crudCalls.some(({ sql, params }) => (
    /UPDATE customization_step_choices choice/.test(sql) && params.includes(7)
  )));
  assert.strictEqual(
    crudCalls.find(({ sql }) => /INSERT INTO customization_steps/.test(sql)).params[3],
    0,
  );
  assert.strictEqual(
    crudCalls.find(({ sql }) => /INSERT INTO customization_step_choices/.test(sql)).params[6],
    0,
  );
  assert.ok(require("../package.json").scripts.test.includes("checkout-contract.test.js"));
};

const makeResponse = () => ({
  statusCode: null,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const runUploadMiddlewareContracts = async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "customization-upload-"));
  const destination = path.join(temporaryRoot, "customization-choices");
  fs.mkdirSync(destination);
  const app = express();
  app.post(
    "/upload",
    buildCustomizationChoiceImageUpload({ destination }),
    (req, res) => res.status(204).end(),
  );
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const upload = async ({ bytes, type, name }) => {
    const form = new FormData();
    form.append("image", new Blob([bytes], { type }), name);
    return fetch(`http://127.0.0.1:${port}/upload`, { method: "POST", body: form });
  };
  const storedFiles = () => fs.readdirSync(destination);
  const clearStoredFiles = () => {
    for (const filename of storedFiles()) fs.unlinkSync(path.join(destination, filename));
  };

  try {
    const allowed = [
      {
        type: "image/jpeg",
        name: "client-name.jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        extension: ".jpg",
      },
      {
        type: "image/png",
        name: "client-name.png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        extension: ".png",
      },
      {
        type: "image/webp",
        name: "client-name.webp",
        bytes: Buffer.from("RIFF0000WEBP", "ascii"),
        extension: ".webp",
      },
    ];
    for (const fixture of allowed) {
      const response = await upload(fixture);
      assert.strictEqual(response.status, 204, fixture.type);
    }
    const generatedFiles = storedFiles();
    assert.strictEqual(generatedFiles.length, 3);
    for (const fixture of allowed) {
      assert.ok(generatedFiles.some((filename) => filename.endsWith(fixture.extension)));
      assert.ok(!generatedFiles.includes(fixture.name));
    }
    clearStoredFiles();

    const exactLimit = Buffer.alloc(5 * 1024 * 1024);
    allowed[1].bytes.copy(exactLimit, 0, 0, allowed[1].bytes.length);
    let response = await upload({
      bytes: exactLimit,
      type: "image/png",
      name: "exact-limit.png",
    });
    assert.strictEqual(response.status, 204);
    assert.strictEqual(storedFiles().length, 1);
    clearStoredFiles();

    const overLimit = Buffer.alloc((5 * 1024 * 1024) + 1);
    allowed[1].bytes.copy(overLimit, 0, 0, allowed[1].bytes.length);
    response = await upload({
      bytes: overLimit,
      type: "image/png",
      name: "over-limit.png",
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(
      (await response.json()).message,
      "Le fichier dépasse la limite de 5 Mo.",
    );
    assert.deepStrictEqual(storedFiles(), []);

    response = await upload({
      bytes: Buffer.from("plain text"),
      type: "text/plain",
      name: "not-an-image.txt",
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).message, "Type de fichier non autorisé.");
    assert.deepStrictEqual(storedFiles(), []);

    response = await upload({
      bytes: Buffer.from("not really a jpeg"),
      type: "image/jpeg",
      name: "spoofed.jpg",
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).message, "Type de fichier non autorisé.");
    assert.deepStrictEqual(storedFiles(), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
};

const runCustomizationApiContracts = async () => {
  const unexpected = async () => {
    throw new Error("unexpected catalog call");
  };
  const catalogDefaults = {
    createCustomizationChoice: unexpected,
    createCustomizationStep: unexpected,
    deleteCustomizationChoice: unexpected,
    deleteCustomizationStep: unexpected,
    getCustomizationStep: unexpected,
    listCustomizationSteps: unexpected,
    updateCustomizationChoice: unexpected,
    updateCustomizationStep: unexpected,
  };
  const makeController = (catalog, removed = [], logs = []) => buildCustomizationController({
    catalog: { ...catalogDefaults, ...catalog },
    fileSystem: {
      existsSync: () => true,
      unlinkSync: (filePath) => removed.push(filePath),
    },
    logger: { error: (...args) => logs.push(args) },
    publicImagePath: "C:\\public-images",
  });

  const listCalls = [];
  let handlers = makeController({
    listCustomizationSteps: async (shopId) => {
      listCalls.push(shopId);
      return [{ id: 1, name: "Boissons" }];
    },
  });
  let res = makeResponse();
  await handlers.listCustomizationSteps({ shopid: 7 }, res);
  assert.deepStrictEqual(listCalls, [7]);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.payload.data[0].name, "Boissons");

  let stepCreateCalls = 0;
  handlers = makeController({
    createCustomizationStep: async () => {
      stepCreateCalls += 1;
    },
  });
  res = makeResponse();
  await handlers.createCustomizationStep({ shopid: 7, body: { name: "   " } }, res);
  assert.strictEqual(stepCreateCalls, 0);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.payload.data.code, "CUSTOMIZATION_STEP_NAME_REQUIRED");

  let choiceCreateCalls = 0;
  const rejectedUploadRemovals = [];
  handlers = makeController({
    createCustomizationChoice: async () => {
      choiceCreateCalls += 1;
    },
  }, rejectedUploadRemovals);
  res = makeResponse();
  await handlers.createCustomizationChoice({
    shopid: 7,
    params: { id: "20" },
    body: { choice_type: "simple", name: "\t" },
    file: { filename: "new.webp" },
  }, res);
  assert.strictEqual(choiceCreateCalls, 0);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.payload.data.code, "CUSTOMIZATION_CHOICE_NAME_REQUIRED");
  assert.deepStrictEqual(rejectedUploadRemovals, [
    "C:\\public-images\\customization-choices\\new.webp",
  ]);

  res = makeResponse();
  await handlers.createCustomizationChoice({
    shopid: 7,
    params: { id: "20" },
    body: { choice_type: "linked_product", linked_product_id: "42" },
    file: { filename: "unused.png" },
  }, res);
  assert.strictEqual(choiceCreateCalls, 0);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(res.payload.data.code, "CUSTOMIZATION_LINKED_PRODUCT_IMAGE_NOT_ALLOWED");
  assert.ok(rejectedUploadRemovals.some((filePath) => filePath.endsWith("unused.png")));

  const createCalls = [];
  handlers = makeController({
    createCustomizationChoice: async (args) => {
      createCalls.push(args);
      return { insertId: 51 };
    },
  });
  res = makeResponse();
  await handlers.createCustomizationChoice({
    shopid: 7,
    params: { id: "20" },
    body: { choice_type: "simple", name: "Eau" },
    file: { filename: "generated.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(createCalls[0].shopId, 7);
  assert.strictEqual(createCalls[0].stepId, "20");
  assert.strictEqual(createCalls[0].data.image, "generated.webp");

  const sqlFailureRemovals = [];
  handlers = makeController({
    createCustomizationChoice: async () => {
      throw new DomainError(
        422,
        "CUSTOMIZATION_CHOICE_DUPLICATE",
        "duplicate",
        { product_id: 8, product_step_id: 80, choice_id: 40 },
      );
    },
  }, sqlFailureRemovals);
  res = makeResponse();
  await handlers.createCustomizationChoice({
    shopid: 7,
    params: { id: "20" },
    body: { choice_type: "simple", name: "Eau" },
    file: { filename: "failed.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 422);
  assert.deepStrictEqual(res.payload.data, {
    code: "CUSTOMIZATION_CHOICE_DUPLICATE",
    product_id: 8,
    product_step_id: 80,
    choice_id: 40,
  });
  assert.ok(sqlFailureRemovals.some((filePath) => filePath.endsWith("failed.webp")));

  const responseFailureRemovals = [];
  handlers = makeController({
    createCustomizationChoice: async () => ({ insertId: 52 }),
  }, responseFailureRemovals);
  const brokenResponse = {
    status() {
      return this;
    },
    json() {
      throw new Error("socket closed");
    },
  };
  await assert.rejects(
    () => handlers.createCustomizationChoice({
      shopid: 7,
      params: { id: "20" },
      body: { choice_type: "simple", name: "Eau" },
      file: { filename: "committed.webp" },
    }, brokenResponse),
    /socket closed/,
  );
  assert.deepStrictEqual(responseFailureRemovals, []);

  const replacementCalls = [];
  const replacementRemovals = [];
  handlers = makeController({
    listCustomizationSteps: async (shopId) => {
      replacementCalls.push(["list", shopId]);
      return [{ choices: [{ id: 40, choice_type: "simple", image: "old.jpg" }] }];
    },
    updateCustomizationChoice: async (args) => {
      replacementCalls.push(["update", args]);
      return { affectedRows: 1 };
    },
  }, replacementRemovals);
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { name: "Eau plate" },
    file: { filename: "replacement.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(replacementCalls[0][1], 7);
  assert.strictEqual(replacementCalls[1][1].shopId, 7);
  assert.strictEqual(replacementCalls[1][1].data.image, "replacement.webp");
  assert.deepStrictEqual(replacementRemovals, [
    "C:\\public-images\\customization-choices\\old.jpg",
  ]);

  const linkedConversionRemovals = [];
  handlers = makeController({
    listCustomizationSteps: async () => ([{
      choices: [{
        id: 40,
        choice_type: "linked_product",
        image: "inherited-product-image.jpg",
      }],
    }]),
    updateCustomizationChoice: async () => ({ affectedRows: 1 }),
  }, linkedConversionRemovals);
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { choice_type: "simple", name: "Option autonome" },
    file: { filename: "owned-simple-image.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(linkedConversionRemovals, []);

  let partialChoiceUpdateCalls = 0;
  handlers = makeController({
    updateCustomizationChoice: async ({ data }) => {
      partialChoiceUpdateCalls += 1;
      assert.strictEqual(data.choice_type, "simple");
      assert.ok(!Object.prototype.hasOwnProperty.call(data, "name"));
      return { affectedRows: 1 };
    },
  });
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { choice_type: "simple" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(partialChoiceUpdateCalls, 1);

  const failedReplacementRemovals = [];
  const unexpectedErrorLogs = [];
  handlers = makeController({
    listCustomizationSteps: async () => ([{
      choices: [{ id: 40, choice_type: "simple", image: "old.jpg" }],
    }]),
    updateCustomizationChoice: async () => {
      const error = new Error("sql failure: table customization_step_choices missing");
      error.code = "ER_NO_SUCH_TABLE";
      throw error;
    },
  }, failedReplacementRemovals, unexpectedErrorLogs);
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { name: "Eau" },
    file: { filename: "new-on-failure.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.payload.message, "Erreur serveur.");
  assert.deepStrictEqual(res.payload.data, {
    code: "INTERNAL_ERROR",
    product_id: null,
    product_step_id: null,
    choice_id: null,
  });
  assert.ok(!JSON.stringify(res.payload).includes("sql failure"));
  assert.ok(!JSON.stringify(res.payload).includes("ER_NO_SUCH_TABLE"));
  assert.strictEqual(unexpectedErrorLogs.length, 1);
  assert.deepStrictEqual(failedReplacementRemovals, [
    "C:\\public-images\\customization-choices\\new-on-failure.webp",
  ]);

  for (const [handlerName, catalogName, code] of [
    ["updateCustomizationStep", "updateCustomizationStep", "CUSTOMIZATION_STEP_NOT_FOUND"],
    ["deleteCustomizationStep", "deleteCustomizationStep", "CUSTOMIZATION_STEP_NOT_FOUND"],
    ["updateCustomizationChoice", "updateCustomizationChoice", "CUSTOMIZATION_CHOICE_NOT_FOUND"],
    ["deleteCustomizationChoice", "deleteCustomizationChoice", "CUSTOMIZATION_CHOICE_NOT_FOUND"],
  ]) {
    handlers = makeController({ [catalogName]: async () => ({ affectedRows: 0 }) });
    res = makeResponse();
    await handlers[handlerName]({
      shopid: 7,
      params: { id: "999" },
      body: handlerName.includes("Step") ? { name: "Valid" } : { name: "Valid" },
    }, res);
    assert.strictEqual(res.statusCode, 404, handlerName);
    assert.strictEqual(res.payload.data.code, code, handlerName);
  }

  const stepDeleteRemovals = [];
  handlers = makeController({
    deleteCustomizationStep: async ({ shopId, stepId }) => {
      assert.strictEqual(shopId, 7);
      assert.strictEqual(stepId, "20");
      return { affectedRows: 1, images: ["sauce.webp"] };
    },
  }, stepDeleteRemovals);
  res = makeResponse();
  await handlers.deleteCustomizationStep({ shopid: 7, params: { id: "20" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.payload.message, "Étape de personnalisation supprimée.");
  assert.deepStrictEqual(stepDeleteRemovals, [
    "C:\\public-images\\customization-choices\\sauce.webp",
  ]);

  const deleteRemovals = [];
  handlers = makeController({
    deleteCustomizationChoice: async ({ shopId, choiceId }) => {
      assert.strictEqual(shopId, 7);
      assert.strictEqual(choiceId, "40");
      return { affectedRows: 1 };
    },
  }, deleteRemovals);
  res = makeResponse();
  await handlers.deleteCustomizationChoice({ shopid: 7, params: { id: "40" } }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(deleteRemovals, []);

  const traversalRemovals = [];
  handlers = makeController({
    listCustomizationSteps: async () => ([{
      choices: [{ id: 40, choice_type: "simple", image: "../outside.webp" }],
    }]),
    updateCustomizationChoice: async () => ({ affectedRows: 1 }),
  }, traversalRemovals);
  res = makeResponse();
  await handlers.updateCustomizationChoice({
    shopid: 7,
    params: { id: "40" },
    body: { name: "Eau" },
    file: { filename: "safe.webp" },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(traversalRemovals, []);
};

const checkoutInput = (overrides = {}) => ({
  shopId: 7,
  actorId: 9,
  customer: { id: 12, name: "Ada", phone: "0102030405" },
  items: [{ productId: 10, quantity: 2, selectedChoiceIds: [102, 101] }],
  expectedTotal: 23,
  clientOrderToken: "checkout-token-1",
  paymentMode: "cash",
  ...overrides,
});

const checkoutConfiguration = () => new Map([[10, [{
  product_step_id: 20,
  name: "Boisson",
  position: 1,
  minimum_choices: 2,
  maximum_choices: 2,
  active: true,
  available: true,
  choices: [{
    product_step_choice_id: 101,
    choice_type: "simple",
    choice_name: "Eau",
    extra_price: 0.5,
    position: 1,
    active: true,
    available: true,
    linked_product_id: null,
  }, {
    product_step_choice_id: 102,
    choice_type: "linked_product",
    choice_name: "Dessert",
    extra_price: 1,
    position: 2,
    active: true,
    available: true,
    linked_product_id: 30,
  }],
}]]]);

const runSharedOrderQuoteContract = async () => {
  const quote = buildOrderQuoteModule({
    repository: {
      getProducts: async ({ shopId, productIds }) => {
        assert.strictEqual(shopId, 7);
        assert.deepStrictEqual(productIds, [10]);
        return [{
          id: 10,
          shopid: 7,
          name: "Menu",
          price: 8,
          stock: 5,
          archived: 0,
          is_hidden: 0,
        }];
      },
    },
    getResolvedProductConfigurations: async () => new Map([[10, [{
      product_step_id: 20,
      name: "Boisson",
      minimum_choices: 1,
      maximum_choices: 1,
      active: true,
      available: true,
      choices: [{
        product_step_choice_id: 101,
        choice_type: "linked_product",
        choice_name: "Boisson liee",
        extra_price: 1.5,
        active: true,
        available: true,
        linked_product_id: 11,
      }],
    }]]]),
  });

  const result = await quote.quoteOrderItems({
    shopId: 7,
    items: [{ productId: 10, quantity: 2, selectedChoiceIds: [101] }],
    connection: { transaction: true },
  });

  assert.strictEqual(result.total, 19);
  assert.deepStrictEqual([...result.requirements.entries()], [[10, 2], [11, 2]]);
};

const makeCheckoutHarness = ({
  existingOrder = null,
  expectedSnapshotError = false,
  duplicateOnInsert = false,
  paymentMode,
  validateConfiguredItem,
} = {}) => {
  const initial = {
    products: new Map([[10, 10], [30, 5]]),
    orders: existingOrder ? [existingOrder] : [],
    details: [],
    snapshots: [],
    reservations: [],
    movements: [],
    nextOrderId: 500,
    nextDetailId: 700,
    nextReservationId: 900,
  };
  let state = initial;
  const events = [];
  const cloneState = (source) => ({
    products: new Map(source.products),
    orders: source.orders.map((row) => ({ ...row })),
    details: source.details.map((row) => ({ ...row })),
    snapshots: source.snapshots.map((row) => ({ ...row })),
    reservations: source.reservations.map((row) => ({ ...row })),
    movements: source.movements.map((row) => ({ ...row })),
    nextOrderId: source.nextOrderId,
    nextDetailId: source.nextDetailId,
    nextReservationId: source.nextReservationId,
  });
  const repository = {
    findOrderByToken: async ({ shopId, token }) => state.orders.find(
      (row) => row.shopid === shopId && row.client_order_token === token,
    ) || null,
    lockOrderForReservationBackfill: async ({ orderId }) => state.orders.find(
      (row) => row.id === Number(orderId),
    ) || null,
    getLegacyOrderDetails: async ({ orderId }) => {
      const quantities = new Map();
      for (const detail of state.details.filter((row) => row.orderid === Number(orderId))) {
        quantities.set(
          detail.productid,
          (quantities.get(detail.productid) || 0) + Number(detail.qty),
        );
      }
      return [...quantities.entries()]
        .sort(([left], [right]) => left - right)
        .map(([productid, quantity]) => ({ productid, quantity }));
    },
    getProducts: async ({ productIds }) => productIds
      .filter((id) => state.products.has(id))
      .map((id) => ({ id, shopid: 7, name: `Product ${id}`, price: id === 10 ? 10 : 2, stock: state.products.get(id), archived: 0 })),
    lockExpiredReservations: async () => [],
    lockReservationsByOrder: async ({ orderId }) => state.reservations
      .filter((row) => row.order_id === orderId)
      .sort((left, right) => left.product_id - right.product_id),
    lockProducts: async ({ productIds }) => {
      events.push(["lock-products", [...productIds]]);
      return productIds.filter((id) => state.products.has(id)).map((id) => ({
        id,
        stock: state.products.get(id),
      }));
    },
    adjustStock: async ({ productId, delta }) => {
      events.push(["stock", productId, delta]);
      state.products.set(productId, state.products.get(productId) + delta);
      return { affectedRows: 1 };
    },
    insertOrder: async ({ order }) => {
      if (duplicateOnInsert) {
        const error = new Error("duplicate");
        error.code = "ER_DUP_ENTRY";
        throw error;
      }
      const id = state.nextOrderId++;
      state.orders.push({ id, ...order });
      events.push(["insert-order", id]);
      return { insertId: id };
    },
    insertOrderDetail: async ({ detail }) => {
      const id = state.nextDetailId++;
      state.details.push({ id, ...detail });
      events.push(["insert-detail", id]);
      return { insertId: id };
    },
    insertSnapshot: async ({ snapshot }) => {
      if (expectedSnapshotError) throw new Error("snapshot insert failed");
      state.snapshots.push({ ...snapshot });
      events.push(["insert-snapshot", snapshot.product_customization_step_choice_id]);
      return { insertId: state.snapshots.length };
    },
    insertReservation: async ({ reservation }) => {
      const id = state.nextReservationId++;
      state.reservations.push({ id, ...reservation });
      events.push(["insert-reservation", reservation.product_id]);
      return { insertId: id };
    },
    updateReservationStatus: async ({ reservationId, fromStatus, toStatus }) => {
      const reservation = state.reservations.find((row) => row.id === reservationId);
      if (!reservation || reservation.status !== fromStatus) return { affectedRows: 0 };
      reservation.status = toStatus;
      events.push(["reservation-status", reservationId, toStatus]);
      return { affectedRows: 1 };
    },
    insertMovement: async ({ movement }) => {
      state.movements.push({ ...movement });
      events.push(["movement", movement.productid]);
      return { insertId: state.movements.length };
    },
  };
  const withTransaction = async (work) => {
    const before = cloneState(state);
    events.push("begin");
    try {
      const result = await work({ transaction: true });
      events.push("commit");
      return result;
    } catch (error) {
      state = before;
      events.push("rollback");
      throw error;
    }
  };
  const checkout = buildCheckoutModule({
    repository,
    withTransaction,
    getResolvedProductConfigurations: async () => checkoutConfiguration(),
    ...(validateConfiguredItem ? { validateConfiguredItem } : {}),
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  return {
    checkout,
    events,
    repository,
    getState: () => state,
    input: checkoutInput(paymentMode ? { paymentMode } : {}),
  };
};

const makeConcurrentClaimHarness = () => {
  let stock = 1;
  let pendingOrder = null;
  let committedOrder = null;
  let requestSequence = 0;
  let precheckCount = 0;
  let lockCount = 0;
  let releasePrechecks;
  let releaseWinnerCommit;
  const prechecksComplete = new Promise((resolve) => { releasePrechecks = resolve; });
  const winnerCommitted = new Promise((resolve) => { releaseWinnerCommit = resolve; });
  const events = [];
  const reservations = [];
  const repository = {
    findOrderByToken: async ({ connection }) => {
      if (!connection) {
        await winnerCommitted;
        return committedOrder;
      }
      precheckCount += 1;
      if (precheckCount === 2) releasePrechecks();
      await prechecksComplete;
      events.push([connection.requestId, "precheck-empty"]);
      return null;
    },
    getProducts: async () => [{
      id: 10,
      shopid: 7,
      name: "Last item",
      price: 10,
      stock,
      archived: 0,
      is_hidden: 0,
    }],
    lockExpiredReservations: async () => [],
    lockProducts: async ({ connection }) => {
      lockCount += 1;
      events.push([connection.requestId, "lock-products"]);
      if (lockCount > 1) await winnerCommitted;
      return [{ id: 10, stock }];
    },
    adjustStock: async ({ delta }) => {
      stock += delta;
      return { affectedRows: 1 };
    },
    insertOrder: async ({ order, connection }) => {
      events.push([connection.requestId, "claim-attempt"]);
      if (pendingOrder) {
        events.push([connection.requestId, "claim-duplicate"]);
        const error = new Error("duplicate client order token");
        error.code = "ER_DUP_ENTRY";
        throw error;
      }
      pendingOrder = { id: 800, ...order, ownerRequestId: connection.requestId };
      events.push([connection.requestId, "claim-winner"]);
      return { insertId: 800 };
    },
    insertOrderDetail: async () => ({ insertId: 801 }),
    insertSnapshot: async () => ({ insertId: 802 }),
    insertReservation: async ({ reservation }) => {
      reservations.push({ id: 803, ...reservation });
      return { insertId: 803 };
    },
    lockReservationsByOrder: async () => reservations,
    updateReservationStatus: async ({ reservationId, fromStatus, toStatus }) => {
      const row = reservations.find((reservation) => reservation.id === reservationId);
      if (!row || row.status !== fromStatus) return { affectedRows: 0 };
      row.status = toStatus;
      return { affectedRows: 1 };
    },
    insertMovement: async () => ({ insertId: 804 }),
  };
  const runInTransaction = async (work) => {
    const connection = { requestId: ++requestSequence };
    try {
      const result = await work(connection);
      if (pendingOrder && pendingOrder.ownerRequestId === connection.requestId) {
        committedOrder = pendingOrder;
        releaseWinnerCommit();
      }
      return result;
    } catch (error) {
      throw error;
    }
  };
  const checkout = buildCheckoutModule({
    repository,
    withTransaction: runInTransaction,
    getResolvedProductConfigurations: async () => new Map([[10, []]]),
    now: () => new Date("2026-07-24T12:00:00.000Z"),
  });
  const input = (customerName = "Ada") => checkoutInput({
    customer: { id: 12, name: customerName },
    items: [{ productId: 10, quantity: 1, selectedChoiceIds: [] }],
    expectedTotal: 10,
  });
  return {
    checkout,
    events,
    input,
    getStock: () => stock,
  };
};

const runTransactionalCheckoutContracts = async () => {
  assert.strictEqual(
    canonicalPayloadHash(checkoutInput({
      items: [{ productId: 10, quantity: 2, selectedChoiceIds: [101, 102] }],
    })),
    canonicalPayloadHash(checkoutInput()),
    "choice ordering must not affect the idempotency hash",
  );
  assert.strictEqual(
    canonicalPayloadHash(checkoutInput({ shopId: 8, actorId: 99 })),
    canonicalPayloadHash(checkoutInput()),
    "authenticated context is not part of the canonical request body",
  );

  const replayHash = canonicalPayloadHash(checkoutInput());
  let harness = makeCheckoutHarness({
    existingOrder: {
      id: 44,
      shopid: 7,
      subtotal: 23,
      payment_status: "unpaid",
      client_order_token: "checkout-token-1",
      client_order_payload_hash: replayHash,
    },
  });
  let result = await harness.checkout.createCheckout(harness.input);
  assert.deepStrictEqual(result, {
    orderId: 44,
    total: 23,
    idempotent_replay: true,
    payment_status: "unpaid",
  });
  assert.deepStrictEqual(harness.events, ["begin", "commit"]);

  harness = makeCheckoutHarness({
    existingOrder: {
      id: 44,
      shopid: 7,
      subtotal: 20,
      payment_status: "unpaid",
      client_order_token: "checkout-token-1",
      client_order_payload_hash: canonicalPayloadHash(checkoutInput({ expectedTotal: 20 })),
    },
  });
  await assert.rejects(
    () => harness.checkout.createCheckout(harness.input),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
  assert.ok(!harness.events.some((event) => Array.isArray(event) && event[0].startsWith("insert")));

  harness = makeCheckoutHarness();
  await assert.rejects(
    () => harness.checkout.createCheckout(checkoutInput({ expectedTotal: 22 })),
    (error) => error.status === 409
      && error.code === "ORDER_REPRICE_REQUIRED"
      && error.server_quote.total === 23,
  );
  assert.deepStrictEqual(harness.events, ["begin", "rollback"]);
  assert.strictEqual(harness.getState().products.get(10), 10);

  harness = makeCheckoutHarness({ expectedSnapshotError: true });
  await assert.rejects(
    () => harness.checkout.createCheckout(harness.input),
    /snapshot insert failed/,
  );
  assert.strictEqual(harness.getState().orders.length, 0);
  assert.strictEqual(harness.getState().details.length, 0);
  assert.strictEqual(harness.getState().reservations.length, 0);
  assert.deepStrictEqual([...harness.getState().products.entries()], [[10, 10], [30, 5]]);
  assert.ok(harness.events.includes("rollback"));

  harness = makeCheckoutHarness();
  result = await harness.checkout.createCheckout(harness.input);
  assert.deepStrictEqual(result, {
    orderId: 500,
    total: 23,
    idempotent_replay: false,
    payment_status: "unpaid",
  });
  assert.deepStrictEqual(
    harness.events.find((event) => Array.isArray(event) && event[0] === "lock-products"),
    ["lock-products", [10, 30]],
  );
  assert.deepStrictEqual([...harness.getState().products.entries()], [[10, 8], [30, 3]]);
  assert.strictEqual(harness.getState().reservations.length, 2);
  assert.ok(harness.getState().reservations.every((row) => row.status === "committed"));
  assert.strictEqual(harness.getState().movements.length, 2);

  harness = makeCheckoutHarness({ paymentMode: "stripe" });
  result = await harness.checkout.createCheckout(harness.input);
  assert.strictEqual(result.payment_status, "requires_payment");
  assert.ok(harness.getState().reservations.every((row) => row.status === "reserved"));
  assert.ok(harness.getState().reservations.every(
    (row) => row.expires_at === "2026-07-24 12:15:00",
  ));
  assert.strictEqual(harness.getState().movements.length, 0);

  harness = makeCheckoutHarness();
  harness.getState().products.set(30, 1);
  await assert.rejects(
    () => harness.checkout.createCheckout(harness.input),
    (error) => error.status === 409
      && error.code === "INSUFFICIENT_STOCK"
      && error.shortages[0].product_id === 30
      && error.shortages[0].requested === 2,
  );
  assert.deepStrictEqual([...harness.getState().products.entries()], [[10, 10], [30, 1]]);

  const winner = {
    id: 501,
    shopid: 7,
    subtotal: 23,
    payment_status: "unpaid",
    client_order_token: "checkout-token-1",
    client_order_payload_hash: replayHash,
  };
  harness = makeCheckoutHarness({ existingOrder: winner, duplicateOnInsert: true });
  let transactionalReads = 0;
  const originalFind = harness.repository.findOrderByToken;
  harness.repository.findOrderByToken = async (options) => {
    transactionalReads += options.connection ? 1 : 0;
    if (options.connection) return null;
    return originalFind(options);
  };
  result = await harness.checkout.createCheckout(harness.input);
  assert.strictEqual(result.orderId, 501);
  assert.strictEqual(result.idempotent_replay, true);
  assert.strictEqual(transactionalReads, 1);
  assert.ok(harness.events.includes("rollback"));

  let concurrent = makeConcurrentClaimHarness();
  const samePayloadResults = await Promise.all([
    concurrent.checkout.createCheckout(concurrent.input()),
    concurrent.checkout.createCheckout(concurrent.input()),
  ]);
  assert.deepStrictEqual(
    samePayloadResults.map((checkoutResult) => checkoutResult.idempotent_replay).sort(),
    [false, true],
    "same-token loser must replay the winner after the unique claim",
  );
  const duplicateRequestId = concurrent.events.find((event) => event[1] === "claim-duplicate")[0];
  assert.ok(
    !concurrent.events.some(
      (event) => event[0] === duplicateRequestId && event[1] === "lock-products",
    ),
    "the losing request must not reach stock locking after its duplicate claim",
  );
  assert.strictEqual(concurrent.getStock(), 0, "the last unit is consumed exactly once");

  concurrent = makeConcurrentClaimHarness();
  const differentPayloadResults = await Promise.allSettled([
    concurrent.checkout.createCheckout(concurrent.input("Ada")),
    concurrent.checkout.createCheckout(concurrent.input("Grace")),
  ]);
  assert.strictEqual(
    differentPayloadResults.filter((entry) => entry.status === "fulfilled").length,
    1,
  );
  const rejectedRace = differentPayloadResults.find((entry) => entry.status === "rejected");
  assert.strictEqual(rejectedRace.reason.code, "IDEMPOTENCY_KEY_REUSED");
  const reusedRequestId = concurrent.events.find((event) => event[1] === "claim-duplicate")[0];
  assert.ok(!concurrent.events.some(
    (event) => event[0] === reusedRequestId && event[1] === "lock-products",
  ));

  await assert.rejects(
    () => harness.checkout.createCheckout(checkoutInput({ shopId: 0 })),
    (error) => error.code === "CHECKOUT_REQUEST_INVALID",
  );

  for (const [field, invalidInput] of [
    ["shop_id", checkoutInput({ shopId: true })],
    ["actor_id", checkoutInput({ actorId: true })],
    ["customer.id", checkoutInput({ customer: { id: true, name: "Ada" } })],
    ["items.0.product_id", checkoutInput({
      items: [{ productId: true, quantity: 2, selectedChoiceIds: [101, 102] }],
    })],
    ["items.0.quantity", checkoutInput({
      items: [{ productId: 10, quantity: true, selectedChoiceIds: [101, 102] }],
    })],
    ["items.0.selected_choice_ids", checkoutInput({
      items: [{ productId: 10, quantity: 2, selectedChoiceIds: [true, 102] }],
    })],
  ]) {
    const invalidHarness = makeCheckoutHarness();
    await assert.rejects(
      () => invalidHarness.checkout.createCheckout(invalidInput),
      (error) => error.code === "CHECKOUT_REQUEST_INVALID" && error.field === field,
      `boolean ${field} must be rejected before checkout work`,
    );
    assert.deepStrictEqual(invalidHarness.events, []);
  }

  const numericStringHarness = makeCheckoutHarness();
  const numericStringResult = await numericStringHarness.checkout.createCheckout(checkoutInput({
    shopId: "7",
    actorId: "9",
    customer: { id: "12", name: "Ada" },
    items: [{
      productId: "10",
      quantity: "2",
      selectedChoiceIds: ["102", "101"],
    }],
  }));
  assert.strictEqual(numericStringResult.orderId, 500);

  const customizationErrorHarness = makeCheckoutHarness({
    validateConfiguredItem: () => {
      throw new DomainError(
        409,
        "LINKED_PRODUCT_OUT_OF_STOCK",
        "Linked product is out of stock",
        { product_step_id: 20, choice_id: 101 },
      );
    },
  });
  await assert.rejects(
    () => customizationErrorHarness.checkout.createCheckout(customizationErrorHarness.input),
    (error) => error.code === "LINKED_PRODUCT_OUT_OF_STOCK"
      && error.product_id === 10
      && error.product_step_id === 20
      && error.choice_id === 101,
    "customization errors must identify the current parent product",
  );
};

const runReservationContracts = async () => {
  const harness = makeCheckoutHarness({ paymentMode: "stripe" });
  const created = await harness.checkout.createCheckout(harness.input);
  await harness.checkout.finalizeReservations({
    orderId: created.orderId,
    status: "commit",
    operator: 9,
  });
  await harness.checkout.finalizeReservations({
    orderId: created.orderId,
    status: "commit",
    operator: 9,
  });
  assert.ok(harness.getState().reservations.every((row) => row.status === "committed"));
  assert.strictEqual(harness.getState().movements.length, 2, "commit is idempotent");

  const releasing = makeCheckoutHarness({ paymentMode: "stripe" });
  const releaseOrder = await releasing.checkout.createCheckout(releasing.input);
  await releasing.checkout.finalizeReservations({
    orderId: releaseOrder.orderId,
    status: "release",
    operator: 9,
  });
  await releasing.checkout.finalizeReservations({
    orderId: releaseOrder.orderId,
    status: "release",
    operator: 9,
  });
  assert.deepStrictEqual([...releasing.getState().products.entries()], [[10, 10], [30, 5]]);
  assert.ok(releasing.getState().reservations.every((row) => row.status === "released"));

  const expired = makeCheckoutHarness();
  expired.getState().products.set(10, 8);
  expired.getState().reservations.push({
    id: 1,
    order_id: 1,
    product_id: 10,
    quantity: 2,
    status: "reserved",
    expires_at: "2026-07-24 11:00:00",
  });
  expired.repository.lockExpiredReservations = async () => expired.getState().reservations
    .filter((row) => row.status === "reserved");
  assert.strictEqual(await expired.checkout.releaseExpiredReservations(), 1);
  assert.strictEqual(await expired.checkout.releaseExpiredReservations(), 0);
  assert.strictEqual(expired.getState().products.get(10), 10);

  const legacy = makeCheckoutHarness();
  legacy.getState().orders.push({
    id: 66,
    shopid: 7,
    operator: 9,
    customerID: 12,
    client_order_token: null,
  });
  legacy.getState().details.push({
    id: 77,
    orderid: 66,
    productid: 10,
    qty: 2,
    price: 10,
    total: 20,
  });
  let legacyResult = await legacy.checkout.finalizeReservations({
    orderId: 66,
    status: "committed",
    operator: 9,
  });
  assert.strictEqual(legacyResult.compatibility_backfill, true);
  assert.strictEqual(legacy.getState().products.get(10), 8);
  assert.deepStrictEqual(
    legacy.getState().reservations.map((row) => ({
      product_id: row.product_id,
      quantity: row.quantity,
      status: row.status,
    })),
    [{ product_id: 10, quantity: 2, status: "committed" }],
  );
  assert.strictEqual(legacy.getState().movements.length, 1);
  legacyResult = await legacy.checkout.finalizeReservations({
    orderId: 66,
    status: "committed",
    operator: 9,
  });
  assert.strictEqual(legacyResult.changed, 0);
  assert.strictEqual(legacy.getState().products.get(10), 8);
  assert.strictEqual(legacy.getState().movements.length, 1);

  const corruptV2 = makeCheckoutHarness();
  corruptV2.getState().orders.push({
    id: 67,
    shopid: 7,
    operator: 9,
    customerID: 12,
    client_order_token: "v2-token-without-reservation",
  });
  corruptV2.getState().details.push({
    id: 78,
    orderid: 67,
    productid: 10,
    qty: 2,
    price: 10,
    total: 20,
  });
  await assert.rejects(
    () => corruptV2.checkout.finalizeReservations({
      orderId: 67,
      status: "committed",
      operator: 9,
    }),
    (error) => error.code === "RESERVATION_INTEGRITY_ERROR" && error.status === 409,
  );
  assert.strictEqual(corruptV2.getState().products.get(10), 10);
  assert.strictEqual(corruptV2.getState().movements.length, 0);
};

const runCheckoutApiSurfaceContracts = async () => {
  const checkoutCalls = [];
  let controller = buildCheckoutController({
    checkout: {
      createCheckout: async (input) => {
        checkoutCalls.push(input);
        return {
          orderId: 77,
          total: 23,
          idempotent_replay: false,
          payment_status: "unpaid",
        };
      },
    },
    logger: { error: () => {} },
  });
  let response = makeResponse();
  await controller({
    shopid: 7,
    id: 9,
    body: {
      customer: { id: "12", name: "Ada", phone: "0102", remark: "Sans sac" },
      items: [{
        product_id: "10",
        quantity: 2,
        selected_product_step_choice_ids: [102, 101],
      }],
      expected_total: "23.00",
      client_order_token: "checkout-token-1",
      payment_mode: "cash",
    },
  }, response);
  assert.strictEqual(response.statusCode, 201);
  assert.deepStrictEqual(checkoutCalls, [{
    shopId: 7,
    actorId: 9,
    customer: { id: "12", name: "Ada", phone: "0102", remark: "Sans sac" },
    items: [{ productId: "10", quantity: 2, selectedChoiceIds: [102, 101] }],
    expectedTotal: "23.00",
    clientOrderToken: "checkout-token-1",
    paymentMode: "cash",
  }]);

  response = makeResponse();
  await controller({
    shopid: 7,
    id: 9,
    body: {
      customer: "Grace",
      customerID: "13",
      phone: "0304",
      remark: "Table 8",
      items: [{ product_id: "10", quantity: 1, selected_choice_ids: [101] }],
      expected_total: "11.50",
      client_order_token: "checkout-token-2",
      payment: "card",
    },
  }, response);
  assert.strictEqual(response.statusCode, 201);
  assert.deepStrictEqual(checkoutCalls[1], {
    shopId: 7,
    actorId: 9,
    customer: { id: "13", name: "Grace", phone: "0304", remark: "Table 8" },
    items: [{ productId: "10", quantity: 1, selectedChoiceIds: [101] }],
    expectedTotal: "11.50",
    clientOrderToken: "checkout-token-2",
    paymentMode: "card",
  });

  response = makeResponse();
  await controller({
    shopid: 7,
    id: 9,
    body: {
      customer: { id: 12, name: "Ada" },
      items: [{
        product_id: 10,
        quantity: 1,
        selected_product_step_choice_ids: [101, 102],
        selected_choice_ids: [102, 101],
      }],
      expected_total: "11.50",
      client_order_token: "checkout-token-3",
      payment_mode: "cash",
    },
  }, response);
  assert.strictEqual(response.statusCode, 201, "equivalent aliases are accepted");
  assert.deepStrictEqual(checkoutCalls[2].items[0].selectedChoiceIds, [101, 102]);

  response = makeResponse();
  await controller({
    shopid: 7,
    id: 9,
    body: {
      customer: { id: 12, name: "Ada" },
      items: [{
        product_id: 10,
        quantity: 1,
        selected_product_step_choice_ids: [101],
        selected_choice_ids: [102],
      }],
      expected_total: "10.50",
      client_order_token: "checkout-token-4",
      payment_mode: "cash",
    },
  }, response);
  assert.strictEqual(response.statusCode, 400);
  assert.deepStrictEqual(response.payload.data, {
    code: "CHECKOUT_REQUEST_INVALID",
    field: "items.0.selected_product_step_choice_ids",
  });
  assert.strictEqual(checkoutCalls.length, 3, "conflicting aliases never reach checkout");

  controller = buildCheckoutController({
    checkout: {
      createCheckout: async () => {
        throw new DomainError(409, "INSUFFICIENT_STOCK", "Insufficient stock", {
          shortages: [{ product_id: 30, requested: 2, available: 1 }],
        });
      },
    },
    logger: { error: () => {} },
  });
  response = makeResponse();
  await controller({ shopid: 7, id: 9, body: { items: [] } }, response);
  assert.strictEqual(response.statusCode, 409);
  assert.deepStrictEqual(response.payload.data, {
    code: "INSUFFICIENT_STOCK",
    shortages: [{ product_id: 30, requested: 2, available: 1 }],
  });

  const logs = [];
  controller = buildCheckoutController({
    checkout: {
      createCheckout: async () => {
        throw new Error("SQL syntax error near client_order_token");
      },
    },
    logger: { error: (...args) => logs.push(args) },
  });
  response = makeResponse();
  await controller({ shopid: 7, id: 9, body: { items: [] } }, response);
  assert.strictEqual(response.statusCode, 500);
  assert.strictEqual(response.payload.data.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(response.payload).includes("SQL"));
  assert.strictEqual(logs.length, 1);

  const orderRouterSource = fs.readFileSync(require.resolve("../src/routers/r_orders"), "utf8");
  const orderControllerSource = fs.readFileSync(require.resolve("../src/controllers/c_orders"), "utf8");
  const checkoutModuleSource = fs.readFileSync(require.resolve("../src/modules/m_checkout"), "utf8");
  const serverSource = fs.readFileSync(require.resolve("../index"), "utf8");
  assert.match(orderRouterSource, /\.post\("\/orders\/checkout", authentication, orders\.checkout\)/);
  assert.match(orderRouterSource, /legacy/i);
  assert.ok(orderControllerSource.includes("buildCheckoutController"));
  assert.ok(checkoutModuleSource.includes("client_order_token"));
  assert.ok(checkoutModuleSource.includes("selected_choice_ids"));
  assert.match(serverSource, /setInterval\([\s\S]*releaseExpiredReservations[\s\S]*60 \* 1000/);
  assert.match(serverSource, /\.unref\(\)/);
  assert.ok(require("../package.json").scripts.test.includes("reservation-lifecycle.test.js"));
};

const cloneArchiveState = (state) => ({
  orders: state.orders.map((row) => ({ ...row })),
  details: state.details.map((row) => ({ ...row })),
  activeSnapshots: state.activeSnapshots.map((row) => ({ ...row })),
  legacyCustomizations: state.legacyCustomizations.map((row) => ({ ...row })),
  archives: state.archives.map((row) => ({ ...row })),
  archiveDetails: state.archiveDetails.map((row) => ({ ...row })),
  archiveSnapshots: state.archiveSnapshots.map((row) => ({ ...row })),
  nextArchiveId: state.nextArchiveId,
  nextArchiveDetailId: state.nextArchiveDetailId,
});

const makeArchiveHarness = ({ failAfterActiveDeletion = false } = {}) => {
  let state = {
    orders: [{
      id: 42,
      shopid: 7,
      customerID: 12,
      payment_status: "paid",
      payment_provider: "stripe",
      subtotal: 23,
      created: "2026-07-24 12:00:00",
    }],
    details: [
      { id: 70, orderid: 42, productid: 10, qty: 2, price: 11.5, total: 23 },
      { id: 71, orderid: 42, productid: 20, qty: 1, price: 5, total: 5 },
    ],
    activeSnapshots: [{
      id: 1,
      orderdetail_id: 70,
      product_customization_step_id: 5,
      product_customization_step_choice_id: 8,
      step_name: "Options",
      step_position: 2,
      choice_type: "simple",
      choice_name: "Cola",
      choice_position: 3,
      unit_extra_price: "0.50",
      linked_product_id: null,
      created: "2026-07-24 12:00:00",
    }, {
      id: 2,
      orderdetail_id: 70,
      product_customization_step_id: 6,
      product_customization_step_choice_id: 9,
      step_name: "Options",
      step_position: 4,
      choice_type: "linked_product",
      choice_name: "Tarte",
      choice_position: 1,
      unit_extra_price: "2.00",
      linked_product_id: 30,
      created: "2026-07-24 12:00:00",
    }],
    legacyCustomizations: [{
      order_id: 42,
      order_details_id: 70,
      product_id: 10,
      product_choice_id: 999,
      name: "Legacy must not win",
      price: "9.00",
    }, {
      order_id: 42,
      order_details_id: 71,
      product_id: 20,
      product_choice_id: 12,
      name: "Ancien choix",
      price: "1.25",
    }],
    archives: [],
    archiveDetails: [],
    archiveSnapshots: [],
    nextArchiveId: 100,
    nextArchiveDetailId: 200,
  };
  const events = [];
  const withTransaction = async (work) => {
    const before = cloneArchiveState(state);
    events.push("begin");
    try {
      const result = await work({ transaction: true });
      events.push("commit");
      return result;
    } catch (error) {
      state = before;
      events.push("rollback");
      throw error;
    }
  };
  const repository = {
    findOrderForArchive: async ({ orderId, shopId }) => state.orders.find(
      (row) => row.id === Number(orderId) && (shopId == null || row.shopid === Number(shopId)),
    ) || null,
    insertArchive: async ({ archive }) => {
      const id = state.nextArchiveId++;
      state.archives.push({ id, ...archive });
      events.push(["insert-archive", id]);
      return { insertId: id };
    },
    findOrderDetails: async ({ orderId }) => state.details.filter(
      (row) => row.orderid === Number(orderId),
    ),
    findActiveSnapshots: async ({ detailIds }) => state.activeSnapshots
      .filter((row) => detailIds.includes(row.orderdetail_id))
      .sort((left, right) => left.step_position - right.step_position
        || left.choice_position - right.choice_position),
    insertArchiveDetail: async ({ detail }) => {
      const id = state.nextArchiveDetailId++;
      state.archiveDetails.push({ id, ...detail });
      events.push(["insert-archive-detail", id]);
      return { insertId: id };
    },
    insertArchiveSnapshot: async ({ snapshot }) => {
      state.archiveSnapshots.push({ id: state.archiveSnapshots.length + 1, ...snapshot });
      events.push(["insert-archive-snapshot", snapshot.archivesdetail_id]);
      return { insertId: state.archiveSnapshots.length };
    },
    deleteActiveSnapshots: async ({ detailIds }) => {
      state.activeSnapshots = state.activeSnapshots.filter(
        (row) => !detailIds.includes(row.orderdetail_id),
      );
      events.push("delete-active-snapshots");
      return { affectedRows: detailIds.length };
    },
    deleteLegacyCustomizations: async ({ orderId }) => {
      state.legacyCustomizations = state.legacyCustomizations.filter(
        (row) => row.order_id !== Number(orderId),
      );
      return { affectedRows: 2 };
    },
    deleteOrderDetails: async ({ orderId }) => {
      state.details = state.details.filter((row) => row.orderid !== Number(orderId));
      events.push("delete-order-details");
      return { affectedRows: 2 };
    },
    deleteOrder: async ({ orderId }) => {
      const before = state.orders.length;
      state.orders = state.orders.filter((row) => row.id !== Number(orderId));
      events.push("delete-order");
      if (failAfterActiveDeletion) throw new Error("post-delete archive failure");
      return { affectedRows: before - state.orders.length };
    },
    findActiveOrderDetails: async ({ orderId }) => state.details
      .filter((row) => row.orderid === Number(orderId))
      .map((row) => ({ ...row, id: Number(orderId), orderDetailsId: row.id })),
    findLegacyCustomizations: async ({ orderId, detailIds }) => state.legacyCustomizations
      .filter((row) => row.order_id === Number(orderId)
        && detailIds.includes(row.order_details_id)),
    findArchivedOrderDetailsById: async ({ archiveId }) => state.archiveDetails
      .filter((row) => row.orderId === Number(archiveId))
      .map((row) => ({ ...row, id: Number(archiveId), archiveDetailsId: row.id })),
    findArchivedOrderDetailsByToken: async ({ token }) => {
      const archive = state.archives.find((row) => row.token === token);
      if (!archive) return [];
      return state.archiveDetails.filter((row) => row.orderId === archive.id)
        .map((row) => ({ ...row, id: archive.id, archiveDetailsId: row.id }));
    },
    findArchiveSnapshots: async ({ detailIds }) => state.archiveSnapshots
      .filter((row) => detailIds.includes(row.archivesdetail_id))
      .sort((left, right) => left.step_position - right.step_position
        || left.choice_position - right.choice_position),
  };
  const orderModule = buildOrderArchiveModule({
    repository,
    withTransaction,
    createToken: () => "archive-token-42",
  });
  return {
    orderModule,
    events,
    getState: () => state,
  };
};

const runArchiveSnapshotContracts = async () => {
  let harness = makeArchiveHarness();
  const active = await harness.orderModule.mDetailOrder(42);
  assert.deepStrictEqual(active[0].customizationList, [{
    product_customization_step_id: 5,
    step_name: "Options",
    step_position: 2,
    name: "Cola",
    choice_position: 3,
    price: 0.5,
    product_choice_id: null,
  }, {
    product_customization_step_id: 6,
    step_name: "Options",
    step_position: 4,
    name: "Tarte",
    choice_position: 1,
    price: 2,
    product_choice_id: null,
  }]);
  assert.deepStrictEqual(active[1].customizationList, [{
    name: "Ancien choix",
    product_choice_id: 12,
    price: 1.25,
  }]);

  const archiveResult = await harness.orderModule.mArchiveOrder(42, "Carte", 7);
  assert.strictEqual(archiveResult.affectedRows, 1);
  assert.strictEqual(harness.getState().orders.length, 0);
  assert.strictEqual(harness.getState().details.length, 0);
  assert.strictEqual(harness.getState().activeSnapshots.length, 0);
  assert.strictEqual(harness.getState().archiveDetails.length, 2);
  assert.deepStrictEqual(
    harness.getState().archiveSnapshots.map((row) => ({
      archivesdetail_id: row.archivesdetail_id,
      product_customization_step_id: row.product_customization_step_id,
      step_name: row.step_name,
      step_position: row.step_position,
      choice_name: row.choice_name,
      choice_position: row.choice_position,
      unit_extra_price: row.unit_extra_price,
      linked_product_id: row.linked_product_id,
    })),
    [{
      archivesdetail_id: 200,
      product_customization_step_id: 5,
      step_name: "Options",
      step_position: 2,
      choice_name: "Cola",
      choice_position: 3,
      unit_extra_price: "0.50",
      linked_product_id: null,
    }, {
      archivesdetail_id: 200,
      product_customization_step_id: 6,
      step_name: "Options",
      step_position: 4,
      choice_name: "Tarte",
      choice_position: 1,
      unit_extra_price: "2.00",
      linked_product_id: 30,
    }],
  );
  assert.ok(
    harness.events.findIndex((event) => Array.isArray(event)
      && event[0] === "insert-archive-snapshot")
      < harness.events.indexOf("delete-active-snapshots"),
  );

  const archived = await harness.orderModule.mDetailArchivedOrder(100);
  assert.deepStrictEqual(archived[0].customizationList, [{
    product_customization_step_id: 5,
    step_name: "Options",
    step_position: 2,
    name: "Cola",
    choice_position: 3,
    price: 0.5,
    product_choice_id: null,
  }, {
    product_customization_step_id: 6,
    step_name: "Options",
    step_position: 4,
    name: "Tarte",
    choice_position: 1,
    price: 2,
    product_choice_id: null,
  }]);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(archived[1], "customizationList"),
    false,
    "legacy archives without snapshots keep their existing shape",
  );
  const archivedByToken = await harness.orderModule.mDetailArchivedOrderByToken(
    "archive-token-42",
  );
  assert.deepStrictEqual(archivedByToken, archived);

  harness = makeArchiveHarness({ failAfterActiveDeletion: true });
  await assert.rejects(
    () => harness.orderModule.mArchiveOrder(42, "Carte", 7),
    /post-delete archive failure/,
  );
  assert.strictEqual(harness.getState().orders.length, 1);
  assert.strictEqual(harness.getState().details.length, 2);
  assert.strictEqual(harness.getState().activeSnapshots.length, 2);
  assert.strictEqual(harness.getState().legacyCustomizations.length, 2);
  assert.strictEqual(harness.getState().archives.length, 0);
  assert.strictEqual(harness.getState().archiveDetails.length, 0);
  assert.strictEqual(harness.getState().archiveSnapshots.length, 0);
  assert.ok(harness.events.includes("rollback"));
};

runProductReadContracts()
  .then(runProductWriteContracts)
  .then(runProductControllerContracts)
  .then(runRepositoryReadContracts)
  .then(runUploadMiddlewareContracts)
  .then(runCustomizationApiContracts)
  .then(runSharedOrderQuoteContract)
  .then(runTransactionalCheckoutContracts)
  .then(runReservationContracts)
  .then(runCheckoutApiSurfaceContracts)
  .then(runArchiveSnapshotContracts)
  .then(() => console.log("customization and checkout contracts passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
