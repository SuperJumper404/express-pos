const buildStockRequirements = (items) => {
  const requirements = new Map();
  const add = (productId, quantity) => {
    requirements.set(productId, (requirements.get(productId) || 0) + quantity);
  };

  for (const item of items) {
    add(item.product.id, item.quantity);
    for (const choice of item.selectedChoices) {
      if (choice.choice_type === "linked_product") {
        add(choice.linked_product_id, item.quantity);
      }
    }
  }

  return requirements;
};

module.exports = {
  buildStockRequirements,
};
