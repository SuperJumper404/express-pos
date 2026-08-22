const stockInventory = require("../controllers/c_stockInventory");
const { authentication, authorizeStocks } = require("../helpers/middleware/auth");
const express = require("express");

const routers = express.Router();

routers
  .get("/stock/items", authentication, authorizeStocks, stockInventory.listItems)
  .get("/stock/low", authentication, authorizeStocks, stockInventory.listLowItems)
  .post("/stock/ingredients", authentication, authorizeStocks, stockInventory.createIngredient)
  .post("/stock/inventory/bulk", authentication, authorizeStocks, stockInventory.bulkInventory)
  .get("/stock/items/:id", authentication, authorizeStocks, stockInventory.detailItem)
  .patch("/stock/items/:id", authentication, authorizeStocks, stockInventory.updateItem)
  .delete("/stock/items/:id", authentication, authorizeStocks, stockInventory.deleteIngredient)
  .post("/stock/items/:id/archive", authentication, authorizeStocks, stockInventory.archiveIngredient)
  .post("/stock/items/:id/replenishments", authentication, authorizeStocks, stockInventory.replenishItem)
  .post("/stock/items/:id/inventories", authentication, authorizeStocks, stockInventory.inventoryItem)
  .post("/stock/shopping-list/generate", authentication, authorizeStocks, stockInventory.generateShoppingList)
  .get("/stock/shopping-list", authentication, authorizeStocks, stockInventory.listShoppingList)
  .patch("/stock/shopping-list/:id/taken", authentication, authorizeStocks, stockInventory.setShoppingListTaken);

module.exports = routers;
