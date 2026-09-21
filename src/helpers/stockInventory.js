const toInteger = (value) => {
  if (value === "" || value === null || value === undefined) return NaN;
  const number = Number(value);
  return Number.isInteger(number) ? number : NaN;
};

const toNonNegativeInteger = (value, fieldName) => {
  const number = toInteger(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return number;
};

const toPositiveInteger = (value, fieldName) => {
  const number = toInteger(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return number;
};

const resolveStockStatus = (item) => {
  const current = Number(item.current_stock);
  const minimum = Number(item.minimum_stock);
  const target = Number(item.target_stock);
  if (current < minimum) return "red";
  if (current < target) return "orange";
  return "normal";
};

const moneyOrNull = (value) => (
  value === null || value === undefined ? null : Number(Number(value).toFixed(2))
);

const buildShoppingListItem = (item) => {
  const current = Number(item.current_stock);
  const target = Number(item.target_stock);
  if (current >= target) return null;

  const quantity = target - current;
  const unitPrice = moneyOrNull(item.average_unit_price);
  return {
    stock_item_id: item.id,
    status_at_generation: resolveStockStatus(item),
    current_stock_at_generation: current,
    target_stock_at_generation: target,
    quantity_to_buy: quantity,
    estimated_unit_price: unitPrice,
    estimated_total_price: unitPrice === null ? null : moneyOrNull(unitPrice * quantity),
    taken: 0,
  };
};

const calculateAverageUnitPrice = (movements) => {
  const totals = movements.reduce((acc, movement) => {
    const quantity = Number(movement.quantity || 0);
    const totalPrice = Number(movement.total_price || 0);
    if (quantity > 0 && totalPrice > 0) {
      acc.quantity += quantity;
      acc.total += totalPrice;
    }
    return acc;
  }, { quantity: 0, total: 0 });
  if (totals.quantity === 0) return null;
  return Number((totals.total / totals.quantity).toFixed(2));
};

const isStockTrackedProduct = (product = {}) => (
  product.track_stock === true ||
  product.track_stock === 1 ||
  product.track_stock === "1"
);

module.exports = {
  toNonNegativeInteger,
  toPositiveInteger,
  resolveStockStatus,
  buildShoppingListItem,
  calculateAverageUnitPrice,
  isStockTrackedProduct,
};
