const { buildShoppingListItem, calculateAverageUnitPrice } = require("../helpers/stockInventory");
const { withTransaction } = require("../helpers/withTransaction");

let conn;

const getConnection = () => {
  if (!conn) conn = require("../config/db");
  return conn;
};

const query = (sql, params = []) => new Promise((resolve, reject) => {
  getConnection().query(sql, params, (error, result) => {
    if (error) reject(new Error(error));
    else resolve(result);
  });
});

const rows = (sql, params = []) => query(sql, params);

const queryWith = async (connection, sql, params = []) => {
  const [result] = await connection.query(sql, params);
  return result;
};

const listItemsWith = async (connection, shopId) => queryWith(connection, `
  SELECT si.*,
    (
      SELECT ROUND(SUM(sm.total_price) / SUM(sm.quantity), 2)
      FROM stock_movements sm
      WHERE sm.stock_item_id = si.id
        AND sm.movement_type = 'replenishment'
        AND sm.quantity > 0
        AND sm.total_price IS NOT NULL
        AND sm.total_price > 0
    ) AS average_unit_price
  FROM stock_items si
  WHERE si.shop_id = ?
  ORDER BY si.item_type ASC, si.name ASC
`, [shopId]);

const listItems = async (shopId) => rows(`
  SELECT si.*,
    (
      SELECT ROUND(SUM(sm.total_price) / SUM(sm.quantity), 2)
      FROM stock_movements sm
      WHERE sm.stock_item_id = si.id
        AND sm.movement_type = 'replenishment'
        AND sm.quantity > 0
        AND sm.total_price IS NOT NULL
        AND sm.total_price > 0
    ) AS average_unit_price
  FROM stock_items si
  WHERE si.shop_id = ?
  ORDER BY si.item_type ASC, si.name ASC
`, [shopId]);

const detailItem = async ({ shopId, id }) => {
  const found = await rows("SELECT * FROM stock_items WHERE shop_id = ? AND id = ?", [shopId, id]);
  return found[0] || null;
};

const detailItemForUpdate = async (connection, { shopId, id }) => {
  const found = await queryWith(
    connection,
    "SELECT * FROM stock_items WHERE shop_id = ? AND id = ? FOR UPDATE",
    [shopId, id],
  );
  return found[0] || null;
};

const listMovements = ({ shopId, stockItemId }) => rows(`
  SELECT sm.*, users.username
  FROM stock_movements sm
  LEFT JOIN users ON users.id = sm.operator_id
  WHERE sm.shop_id = ? AND sm.stock_item_id = ?
  ORDER BY sm.created_at DESC, sm.id DESC
`, [shopId, stockItemId]);

const createIngredient = async ({ shopId, data }) => query("INSERT INTO stock_items SET ?", {
  shop_id: shopId,
  item_type: "ingredient",
  ...data,
});

const updateItem = async ({ shopId, id, data }) => withTransaction(async (connection) => {
  const item = await detailItemForUpdate(connection, { shopId, id });
  if (!item) return { affectedRows: 0 };
  const result = await queryWith(
    connection,
    "UPDATE stock_items SET ? WHERE shop_id = ? AND id = ?",
    [data, shopId, id],
  );
  if (item.item_type === "product") {
    await queryWith(
      connection,
      "UPDATE products SET stock = ? WHERE stock_item_id = ?",
      [data.current_stock, id],
    );
  }
  return result;
});

const insertMovement = async ({ shopId, stockItemId, movement }) => query("INSERT INTO stock_movements SET ?", {
  shop_id: shopId,
  stock_item_id: stockItemId,
  ...movement,
});

const updateStock = async ({ shopId, id, newStock }) => query(
  "UPDATE stock_items SET current_stock = ? WHERE shop_id = ? AND id = ?",
  [newStock, shopId, id],
);

const syncProductStock = async ({ stockItemId, newStock }) => query(
  "UPDATE products SET stock = ? WHERE stock_item_id = ?",
  [newStock, stockItemId],
);

const applyStockMovement = async ({ shopId, stockItemId, movementType, payload, operatorId }) => (
  withTransaction(async (connection) => {
    const item = await detailItemForUpdate(connection, { shopId, id: stockItemId });
    if (!item) return { affectedRows: 0 };

    const previousStock = Number(item.current_stock);
    const newStock = movementType === "replenishment"
      ? previousStock + payload.quantity
      : payload.quantity;
    const movement = {
      movement_type: movementType,
      quantity: payload.quantity,
      previous_stock: previousStock,
      new_stock: newStock,
      remark: payload.remark,
      operator_id: operatorId,
    };
    if (movementType === "replenishment") {
      movement.supplier = payload.supplier;
      movement.unit_price = payload.unit_price;
      movement.total_price = payload.total_price;
    }

    await queryWith(connection, "INSERT INTO stock_movements SET ?", {
      shop_id: shopId,
      stock_item_id: stockItemId,
      ...movement,
    });
    const result = await queryWith(
      connection,
      "UPDATE stock_items SET current_stock = ? WHERE shop_id = ? AND id = ?",
      [newStock, shopId, stockItemId],
    );
    if (item.item_type === "product") {
      await queryWith(
        connection,
        "UPDATE products SET stock = ? WHERE stock_item_id = ?",
        [newStock, stockItemId],
      );
    }
    return result;
  })
);

const replenishItem = async ({ shopId, stockItemId, payload, operatorId }) => applyStockMovement({
  shopId,
  stockItemId,
  movementType: "replenishment",
  payload,
  operatorId,
});

const inventoryItem = async ({ shopId, stockItemId, payload, operatorId }) => applyStockMovement({
  shopId,
  stockItemId,
  movementType: "inventory",
  payload,
  operatorId,
});

const clearShoppingList = async (shopId) => query(
  "DELETE FROM shopping_list_items WHERE shop_id = ?",
  [shopId],
);

const insertShoppingListItem = async ({ shopId, item }) => query("INSERT INTO shopping_list_items SET ?", {
  shop_id: shopId,
  ...item,
});

const listShoppingList = async (shopId) => rows(`
  SELECT sli.*, si.name, si.unit, si.item_type, si.default_supplier
  FROM shopping_list_items sli
  JOIN stock_items si ON si.id = sli.stock_item_id
  WHERE sli.shop_id = ?
  ORDER BY sli.taken ASC,
    FIELD(sli.status_at_generation, 'red', 'orange'),
    si.name ASC
`, [shopId]);

const setShoppingListTaken = async ({ shopId, id, taken }) => query(
  "UPDATE shopping_list_items SET taken = ? WHERE shop_id = ? AND id = ?",
  [taken ? 1 : 0, shopId, id],
);

const generateShoppingList = async (shopId) => {
  await withTransaction(async (connection) => {
    const items = await listItemsWith(connection, shopId);
    await queryWith(connection, "DELETE FROM shopping_list_items WHERE shop_id = ?", [shopId]);
    const projected = items.map(buildShoppingListItem).filter(Boolean);
    for (const item of projected) {
      await queryWith(connection, "INSERT INTO shopping_list_items SET ?", {
        shop_id: shopId,
        ...item,
      });
    }
  });
  return listShoppingList(shopId);
};

module.exports = {
  listItems,
  detailItem,
  listMovements,
  createIngredient,
  updateItem,
  insertMovement,
  updateStock,
  syncProductStock,
  replenishItem,
  inventoryItem,
  generateShoppingList,
  listShoppingList,
  setShoppingListTaken,
  calculateAverageUnitPrice,
};
