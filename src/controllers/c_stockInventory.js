const { custom, success, failed } = require("../helpers/response");
const stockInventory = require("../modules/m_stockInventory");
const {
  toNonNegativeInteger,
  toPositiveInteger,
  resolveStockStatus,
} = require("../helpers/stockInventory");

const optionalText = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return String(value).trim();
};

const optionalDate = (value) => {
  const date = optionalText(value);
  if (date === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error("La date d'achat est invalide.");
  }
  return date;
};

const validateStockItemPayload = (body) => {
  const name = optionalText(body.name);
  const unit = optionalText(body.unit);
  if (!name) throw new Error("Le nom est requis.");
  if (!unit) throw new Error("L'unite est requise.");
  const currentStock = toNonNegativeInteger(body.current_stock, "stock actuel");
  const minimumStock = toNonNegativeInteger(body.minimum_stock, "seuil minimum");
  const targetStock = toNonNegativeInteger(body.target_stock, "stock cible");
  if (targetStock < minimumStock) {
    throw new Error("Le stock cible doit etre superieur ou egal au seuil minimum.");
  }
  return {
    name,
    unit,
    current_stock: currentStock,
    minimum_stock: minimumStock,
    target_stock: targetStock,
    category_label: optionalText(body.category_label),
    reference: optionalText(body.reference),
    default_supplier: optionalText(body.default_supplier),
    note: optionalText(body.note),
  };
};

const validateReplenishmentPayload = (body) => {
  const quantity = toPositiveInteger(body.quantity, "quantite");
  const unitPrice = body.unit_price === undefined || body.unit_price === null || body.unit_price === ""
    ? null
    : Number(Number(body.unit_price).toFixed(2));
  const totalPrice = body.total_price === undefined || body.total_price === null || body.total_price === ""
    ? (unitPrice === null ? null : Number((unitPrice * quantity).toFixed(2)))
    : Number(Number(body.total_price).toFixed(2));
  return {
    quantity,
    supplier: optionalText(body.supplier),
    reference: optionalText(body.reference),
    purchase_date: optionalDate(body.purchase_date),
    unit_price: unitPrice,
    total_price: totalPrice,
    remark: optionalText(body.remark),
  };
};

const validateInventoryPayload = (body) => ({
  quantity: toNonNegativeInteger(body.quantity, "quantite"),
  remark: optionalText(body.remark),
});

const validateBulkInventoryPayload = (body) => {
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new Error("Au moins une ligne d'inventaire est requise.");
  }
  const seen = new Set();
  return body.items.map((item) => {
    const stockItemId = toPositiveInteger(item.stock_item_id, "article");
    if (seen.has(stockItemId)) throw new Error("Un article ne peut etre inventorie qu'une fois.");
    seen.add(stockItemId);
    return {
      stock_item_id: stockItemId,
      quantity: toNonNegativeInteger(item.quantity, "quantite"),
      remark: optionalText(item.remark),
    };
  });
};

const mapStockItemResponse = (item) => ({
  ...item,
  status: resolveStockStatus(item),
});

const parseTaken = (value) => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalized === true || normalized === 1 || normalized === "1" || normalized === "true") return true;
  if (normalized === false || normalized === 0 || normalized === "0" || normalized === "false") return false;
  throw new Error("La valeur taken doit etre un booleen.");
};

const shopIdFromReq = (req) => req.shopid;
const operatorIdFromReq = (req) => req.id ?? null;

const listItems = async (req, res) => {
  try {
    const items = await stockInventory.listItems(shopIdFromReq(req));
    success(res, "Articles de stock recuperes.", null, items.map(mapStockItemResponse));
  } catch (error) {
    failed(res, "Erreur serveur.", error.message);
  }
};

const listLowItems = async (req, res) => {
  try {
    const items = await stockInventory.listLowItems(shopIdFromReq(req));
    return success(res, "Stocks bas recuperes.", null, items.map(mapStockItemResponse));
  } catch (error) {
    return failed(res, "Erreur serveur.", error.message);
  }
};

const createIngredient = async (req, res) => {
  try {
    const data = validateStockItemPayload(req.body);
    await stockInventory.createIngredient({ shopId: shopIdFromReq(req), data });
    success(res, "Ingredient cree avec succes.", null, null);
  } catch (error) {
    custom(res, 400, error.message, {}, null);
  }
};

const updateItem = async (req, res) => {
  try {
    const data = validateStockItemPayload(req.body);
    const result = await stockInventory.updateItem({ shopId: shopIdFromReq(req), id: req.params.id, data });
    if (!result.affectedRows) return custom(res, 404, "Article introuvable.", null, []);
    return success(res, "Article de stock mis a jour.", null, null);
  } catch (error) {
    custom(res, 400, error.message, {}, null);
  }
};

const detailItem = async (req, res) => {
  try {
    const item = await stockInventory.detailItem({ shopId: shopIdFromReq(req), id: req.params.id });
    if (!item) return custom(res, 404, "Article introuvable.", null, []);
    const movements = await stockInventory.listMovements({ shopId: shopIdFromReq(req), stockItemId: req.params.id });
    return success(res, "Article de stock recupere.", null, {
      item: mapStockItemResponse(item),
      movements,
    });
  } catch (error) {
    return failed(res, "Erreur serveur.", error.message);
  }
};

const replenishItem = async (req, res) => {
  try {
    const shopId = shopIdFromReq(req);
    const payload = validateReplenishmentPayload(req.body);
    const result = await stockInventory.replenishItem({
      shopId,
      stockItemId: req.params.id,
      payload,
      operatorId: operatorIdFromReq(req),
    });
    if (!result.affectedRows) return custom(res, 404, "Article introuvable.", null, []);
    return success(res, "Stock reapprovisionne avec succes.", null, null);
  } catch (error) {
    return custom(res, 400, error.message, {}, null);
  }
};

const inventoryItem = async (req, res) => {
  try {
    const shopId = shopIdFromReq(req);
    const payload = validateInventoryPayload(req.body);
    const result = await stockInventory.inventoryItem({
      shopId,
      stockItemId: req.params.id,
      payload,
      operatorId: operatorIdFromReq(req),
    });
    if (!result.affectedRows) return custom(res, 404, "Article introuvable.", null, []);
    return success(res, "Inventaire enregistre.", null, null);
  } catch (error) {
    return custom(res, 400, error.message, {}, null);
  }
};

const bulkInventory = async (req, res) => {
  try {
    const items = validateBulkInventoryPayload(req.body);
    const result = await stockInventory.bulkInventory({
      shopId: shopIdFromReq(req),
      items,
      operatorId: operatorIdFromReq(req),
    });
    return success(res, "Inventaire en masse enregistre.", null, {
      affected_rows: result.affectedRows,
    });
  } catch (error) {
    return custom(res, 400, error.message, {}, null);
  }
};

const archiveIngredient = async (req, res) => {
  try {
    const result = await stockInventory.archiveIngredient({
      shopId: shopIdFromReq(req),
      id: req.params.id,
    });
    if (!result.affectedRows) return custom(res, 404, "Ingredient introuvable.", null, []);
    return success(res, "Ingredient archive.", null, null);
  } catch (error) {
    return failed(res, "Erreur serveur.", error.message);
  }
};

const deleteIngredient = async (req, res) => {
  try {
    const result = await stockInventory.deleteIngredient({
      shopId: shopIdFromReq(req),
      id: req.params.id,
    });
    if (result.hasHistory) {
      return custom(
        res,
        409,
        "Cet ingredient possede un historique et doit etre archive.",
        null,
        { code: "STOCK_ITEM_HAS_HISTORY" },
      );
    }
    if (!result.affectedRows) return custom(res, 404, "Ingredient introuvable.", null, []);
    return success(res, "Ingredient supprime.", null, null);
  } catch (error) {
    return failed(res, "Erreur serveur.", error.message);
  }
};

const generateShoppingList = async (req, res) => {
  try {
    const list = await stockInventory.generateShoppingList(shopIdFromReq(req));
    success(res, "Liste de courses generee.", null, list);
  } catch (error) {
    failed(res, "Erreur serveur.", error.message);
  }
};

const listShoppingList = async (req, res) => {
  try {
    const list = await stockInventory.listShoppingList(shopIdFromReq(req));
    success(res, "Liste de courses recuperee.", null, list);
  } catch (error) {
    failed(res, "Erreur serveur.", error.message);
  }
};

const setShoppingListTaken = async (req, res) => {
  let taken;
  try {
    taken = parseTaken(req.body.taken);
  } catch (error) {
    return custom(res, 400, error.message, {}, null);
  }
  try {
    const result = await stockInventory.setShoppingListTaken({
      shopId: shopIdFromReq(req),
      id: req.params.id,
      taken,
    });
    if (!result.affectedRows) return custom(res, 404, "Ligne de course introuvable.", null, []);
    return success(res, "Ligne de course mise a jour.", null, null);
  } catch (error) {
    failed(res, "Erreur serveur.", error.message);
  }
};

module.exports = {
  validateStockItemPayload,
  validateReplenishmentPayload,
  validateInventoryPayload,
  validateBulkInventoryPayload,
  mapStockItemResponse,
  parseTaken,
  listItems,
  listLowItems,
  createIngredient,
  updateItem,
  detailItem,
  replenishItem,
  inventoryItem,
  bulkInventory,
  archiveIngredient,
  deleteIngredient,
  generateShoppingList,
  listShoppingList,
  setShoppingListTaken,
};
