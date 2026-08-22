const { isStockTrackedProduct } = require("./stockInventory");

const buildStockRequirements = (items) => {
  const requirements = new Map();
  const add = (productId, quantity) => {
    requirements.set(productId, (requirements.get(productId) || 0) + quantity);
  };

  for (const item of items) {
    if (isStockTrackedProduct(item.product)) add(item.product.id, item.quantity);
    for (const choice of item.selectedChoices) {
      if (
        choice.choice_type === "linked_product"
        && isStockTrackedProduct({ track_stock: choice.linked_product_track_stock })
      ) {
        add(choice.linked_product_id, item.quantity);
      }
    }
  }

  return requirements;
};

module.exports = {
  buildStockRequirements,
};
