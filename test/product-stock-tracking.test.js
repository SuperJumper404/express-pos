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

assert.match(checkoutSource, /SELECT id, shopid, stock, track_stock/);
assert.doesNotMatch(checkoutSource, /linked_product\.track_stock AS linked_product_track_stock/);
assert.match(customizationsSource, /linked_product\.track_stock AS linked_product_track_stock/);
assert.match(customizationsSource, /linked_product_track_stock: row\.linked_product_track_stock/);
assert.match(productsControllerSource, /track_stock/);
assert.match(productsControllerSource, /stock_zero_behavior/);

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

  console.log("product stock tracking tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
