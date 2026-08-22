const assert = require("assert");
const fs = require("fs");
const path = require("path");

const checkoutSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "m_checkout.js"),
  "utf8",
);
const customizationsSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "m_customizations.js"),
  "utf8",
);
const productsControllerSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "controllers", "c_products.js"),
  "utf8",
);
const productsModuleSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "m_products.js"),
  "utf8",
);

assert.match(checkoutSource, /SELECT id, shopid, stock, track_stock/);
assert.doesNotMatch(checkoutSource, /linked_product\.track_stock AS linked_product_track_stock/);
assert.match(customizationsSource, /linked_product\.track_stock AS linked_product_track_stock/);
assert.match(customizationsSource, /linked_product\.stock_zero_behavior AS linked_product_stock_zero_behavior/);
assert.match(customizationsSource, /linked_product_track_stock: row\.linked_product_track_stock/);
assert.match(customizationsSource, /linked_product_stock_zero_behavior: row\.linked_product_stock_zero_behavior/);
assert.match(productsControllerSource, /track_stock/);
assert.match(productsControllerSource, /stock_zero_behavior/);

const quoteSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "m_orderQuote.js"),
  "utf8",
);
const editingSource = fs.readFileSync(
  path.join(__dirname, "..", "src", "modules", "m_orderEditing.js"),
  "utf8",
);
assert.match(quoteSource, /stock, track_stock, stock_zero_behavior, archived, is_hidden/);
assert.match(editingSource, /stock, track_stock, stock_zero_behavior/);
assert.match(productsModuleSource, /LEFT JOIN stock_items si ON si\.id = products\.stock_item_id/);
assert.match(productsModuleSource, /si\.unit AS stock_unit/);
assert.match(productsModuleSource, /si\.minimum_stock/);
assert.match(productsModuleSource, /si\.target_stock/);
assert.match(productsModuleSource, /data\.minimum_stock \?\? product\.minimum_stock \?\? 1/);

const { buildProductController } = require("../src/controllers/c_products");

const responseRecorder = () => {
  const response = {};
  return {
    response,
    res: {
      status: (code) => {
        response.code = code;
        return {
          json: (body) => {
            response.body = body;
            return body;
          },
        };
      },
    },
  };
};

const invalidStockFields = [
  { stock: "1.5" },
  { stock: "Infinity" },
  { stock: "NaN" },
  { minimum_stock: "1.5" },
  { target_stock: "Infinity" },
];

(async () => {
  for (const invalidFields of invalidStockFields) {
    let added = false;
    const controller = buildProductController({
      products: {
        mAddProduct: async () => {
          added = true;
        },
      },
      logger: { error: () => {} },
    });
    const { res, response } = responseRecorder();
    await controller.addProduct({
      shopid: 1,
      file: { filename: "product.jpg" },
      body: {
        name: "Produit",
        categoryid: 1,
        price: 2,
        stock: 2,
        ...invalidFields,
      },
    }, res);
    assert.strictEqual(response.code, 400);
    assert.strictEqual(added, false);
  }

  let createdBody;
  const untrackedController = buildProductController({
    products: {
      mAddProduct: async (body) => { createdBody = body; },
    },
    logger: { error: () => {} },
  });
  let recorded = responseRecorder();
  await untrackedController.addProduct({
    shopid: 1,
    file: { filename: "product.jpg" },
    body: {
      name: "Service",
      categoryid: 1,
      price: 2,
      stock: "",
      track_stock: 0,
    },
  }, recorded.res);
  assert.strictEqual(recorded.response.code, 201);
  assert.strictEqual(createdBody.stock, 0);

  let updatedBody;
  const partialUpdateController = buildProductController({
    products: {
      mUpdateProduct: async (body) => { updatedBody = body; },
    },
    logger: { error: () => {} },
  });
  recorded = responseRecorder();
  await partialUpdateController.updateProduct({
    params: { id: 1 },
    body: { name: "Nom modifie" },
  }, recorded.res);
  assert.strictEqual(recorded.response.code, 200);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(updatedBody, "minimum_stock"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(updatedBody, "target_stock"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(updatedBody, "stock_unit"), false);

  recorded = responseRecorder();
  await partialUpdateController.updateProduct({
    params: { id: 1 },
    body: { minimum_stock: 5, target_stock: 4 },
  }, recorded.res);
  assert.strictEqual(recorded.response.code, 400);

  console.log("product stock tracking tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
