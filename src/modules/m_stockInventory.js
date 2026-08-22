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

const ITEM_SELECT = `
  SELECT si.*,
    COALESCE(p.stock, si.current_stock) AS current_stock,
    p.track_stock,
    p.stock_zero_behavior,
    p.archived AS product_archived,
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
  LEFT JOIN products p ON p.id = si.product_id
`;

const ACTIVE_ITEM_FILTER = `
  si.shop_id = ?
  AND si.archived = 0
  AND (si.item_type = 'ingredient' OR p.archived = 0)
`;

const OPERATIONAL_ITEM_FILTER = `
  ${ACTIVE_ITEM_FILTER}
  AND (si.item_type = 'ingredient' OR p.track_stock = 1)
`;

const listItemsWith = (connection, shopId, operational = false) => queryWith(connection, `
  ${ITEM_SELECT}
  WHERE ${operational ? OPERATIONAL_ITEM_FILTER : ACTIVE_ITEM_FILTER}
  ORDER BY si.item_type ASC, si.name ASC
`, [shopId]);

const listItems = (shopId) => rows(`
  ${ITEM_SELECT}
  WHERE ${ACTIVE_ITEM_FILTER}
  ORDER BY si.item_type ASC, si.name ASC
`, [shopId]);

const listLowItems = (shopId) => rows(`
  ${ITEM_SELECT}
  WHERE ${OPERATIONAL_ITEM_FILTER}
    AND COALESCE(p.stock, si.current_stock) < si.target_stock
  ORDER BY
    CASE WHEN COALESCE(p.stock, si.current_stock) < si.minimum_stock THEN 0 ELSE 1 END,
    si.name ASC
`, [shopId]);

const detailItem = async ({ shopId, id }) => {
  const found = await rows(`
    ${ITEM_SELECT}
    WHERE si.shop_id = ? AND si.id = ?
  `, [shopId, id]);
  return found[0] || null;
};

const detailItemForUpdate = async (connection, { shopId, id }) => {
  const found = await queryWith(connection, `
    SELECT si.*,
      COALESCE(p.stock, si.current_stock) AS current_stock,
      p.track_stock,
      p.archived AS product_archived
    FROM stock_items si
    LEFT JOIN products p ON p.id = si.product_id
    WHERE si.shop_id = ? AND si.id = ?
    FOR UPDATE
  `, [shopId, id]);
  return found[0] || null;
};

const listMovements = ({ shopId, stockItemId }) => rows(`
  SELECT sm.*, users.username
  FROM stock_movements sm
  LEFT JOIN users ON users.id = sm.operator_id
  WHERE sm.shop_id = ? AND sm.stock_item_id = ?
  ORDER BY sm.created_at DESC, sm.id DESC
`, [shopId, stockItemId]);

const createIngredient = ({ shopId, data }) => query("INSERT INTO stock_items SET ?", {
  shop_id: shopId,
  item_type: "ingredient",
  archived: 0,
  ...data,
});

const updateItem = ({ shopId, id, data }) => withTransaction(async (connection) => {
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
      "UPDATE products SET stock = ? WHERE stock_item_id = ? AND shopid = ?",
      [data.current_stock, id, shopId],
    );
  }
  return result;
});

const writeStockLevel = async ({ connection, shopId, item, newStock }) => {
  const result = await queryWith(
    connection,
    "UPDATE stock_items SET current_stock = ? WHERE shop_id = ? AND id = ?",
    [newStock, shopId, item.id],
  );
  if (item.item_type === "product") {
    await queryWith(
      connection,
      "UPDATE products SET stock = ? WHERE stock_item_id = ? AND shopid = ?",
      [newStock, item.id, shopId],
    );
  }
  return result;
};

const writeMovement = ({
  connection, shopId, item, movementType, payload, operatorId,
}) => {
  const previousStock = Number(item.current_stock);
  const newStock = movementType === "replenishment"
    ? previousStock + payload.quantity
    : payload.quantity;
  const movement = {
    shop_id: shopId,
    stock_item_id: item.id,
    movement_type: movementType,
    quantity: payload.quantity,
    previous_stock: previousStock,
    new_stock: newStock,
    remark: payload.remark,
    operator_id: operatorId,
  };
  if (movementType === "replenishment") {
    Object.assign(movement, {
      supplier: payload.supplier,
      reference: payload.reference,
      purchase_date: payload.purchase_date,
      unit_price: payload.unit_price,
      total_price: payload.total_price,
    });
  }
  return queryWith(connection, "INSERT INTO stock_movements SET ?", movement)
    .then(() => writeStockLevel({ connection, shopId, item, newStock }));
};

const applyStockMovement = ({ shopId, stockItemId, movementType, payload, operatorId }) => (
  withTransaction(async (connection) => {
    const item = await detailItemForUpdate(connection, { shopId, id: stockItemId });
    if (!item) return { affectedRows: 0 };
    return writeMovement({ connection, shopId, item, movementType, payload, operatorId });
  })
);

const replenishItem = ({ shopId, stockItemId, payload, operatorId }) => applyStockMovement({
  shopId, stockItemId, movementType: "replenishment", payload, operatorId,
});

const inventoryItem = ({ shopId, stockItemId, payload, operatorId }) => applyStockMovement({
  shopId, stockItemId, movementType: "inventory", payload, operatorId,
});

const bulkInventory = ({ shopId, items, operatorId }) => withTransaction(async (connection) => {
  let affectedRows = 0;
  const orderedItems = [...items].sort((left, right) => left.stock_item_id - right.stock_item_id);
  for (const payload of orderedItems) {
    const item = await detailItemForUpdate(connection, { shopId, id: payload.stock_item_id });
    const operational = item && Number(item.archived) === 0 && (
      item.item_type === "ingredient"
      || (Number(item.product_archived) === 0 && Number(item.track_stock) === 1)
    );
    if (!operational) throw new Error("Article de stock invalide pour l'inventaire.");
    const result = await writeMovement({
      connection,
      shopId,
      item,
      movementType: "inventory",
      payload,
      operatorId,
    });
    affectedRows += Number(result.affectedRows || 0);
  }
  return { affectedRows };
});

const archiveIngredient = ({ shopId, id }) => query(
  `UPDATE stock_items
   SET archived = 1
   WHERE shop_id = ? AND id = ? AND item_type = 'ingredient' AND archived = 0`,
  [shopId, id],
);

const deleteIngredient = ({ shopId, id }) => withTransaction(async (connection) => {
  const item = await detailItemForUpdate(connection, { shopId, id });
  if (!item || item.item_type !== "ingredient") return { affectedRows: 0, hasHistory: false };
  const history = await queryWith(
    connection,
    "SELECT COUNT(*) AS count FROM stock_movements WHERE shop_id = ? AND stock_item_id = ?",
    [shopId, id],
  );
  if (Number(history[0].count) > 0) return { affectedRows: 0, hasHistory: true };
  await queryWith(
    connection,
    "DELETE FROM shopping_list_items WHERE shop_id = ? AND stock_item_id = ?",
    [shopId, id],
  );
  const result = await queryWith(
    connection,
    "DELETE FROM stock_items WHERE shop_id = ? AND id = ? AND item_type = 'ingredient'",
    [shopId, id],
  );
  return { ...result, hasHistory: false };
});

const listShoppingList = (shopId) => rows(`
  SELECT sli.*, si.name, si.unit, si.item_type, si.default_supplier
  FROM shopping_list_items sli
  JOIN stock_items si ON si.id = sli.stock_item_id
  LEFT JOIN products p ON p.id = si.product_id
  WHERE sli.shop_id = ?
    AND si.archived = 0
    AND (si.item_type = 'ingredient' OR (p.archived = 0 AND p.track_stock = 1))
  ORDER BY sli.taken ASC,
    FIELD(sli.status_at_generation, 'red', 'orange'),
    si.name ASC
`, [shopId]);

const setShoppingListTaken = ({ shopId, id, taken }) => query(
  "UPDATE shopping_list_items SET taken = ? WHERE shop_id = ? AND id = ?",
  [taken ? 1 : 0, shopId, id],
);

const generateShoppingList = async (shopId) => {
  await withTransaction(async (connection) => {
    const items = await listItemsWith(connection, shopId, true);
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
  archiveIngredient,
  bulkInventory,
  calculateAverageUnitPrice,
  createIngredient,
  deleteIngredient,
  detailItem,
  generateShoppingList,
  inventoryItem,
  listItems,
  listLowItems,
  listMovements,
  listShoppingList,
  replenishItem,
  setShoppingListTaken,
  updateItem,
};
