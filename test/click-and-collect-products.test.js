const assert = require("assert");
const { buildProductController } = require("../src/controllers/c_products");

const createResponse = () => {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return response;
};

(async () => {
  let requestedShopId = null;
  const controller = buildProductController({
    products: {
      async mPublicClickAndCollectProducts(shopId) {
        requestedShopId = shopId;
        return [
          { id: 1, name: "Tacos", price: 49, archived: 0, is_hidden: 0 },
        ];
      },
    },
    logger: { error() {} },
  });

  const response = createResponse();
  await controller.publicClickAndCollectProducts(
    { params: { shopid: "42" } },
    response
  );

  assert.strictEqual(requestedShopId, "42");
  assert.strictEqual(response.statusCode, 200);
  assert.deepStrictEqual(response.body.data, [
    { id: 1, name: "Tacos", price: 49, archived: 0, is_hidden: 0 },
  ]);
  assert.strictEqual(response.body.message, "Produits publics recuperes.");

  console.log("click and collect products tests passed");
})();
