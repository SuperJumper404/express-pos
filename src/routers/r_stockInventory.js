const stockInventory = require("../controllers/c_stockInventory");
const { authentication, authAdmin } = require("../helpers/middleware/auth");
const express = require("express");

const routers = express.Router();

routers
  .get("/stock/items", authentication, stockInventory.listItems)
  .post("/stock/ingredients", authentication, authAdmin, stockInventory.createIngredient)
  .get("/stock/items/:id", authentication, stockInventory.detailItem)
  .patch("/stock/items/:id", authentication, authAdmin, stockInventory.updateItem)
  .post("/stock/items/:id/replenishments", authentication, stockInventory.replenishItem)
  .post("/stock/items/:id/inventories", authentication, stockInventory.inventoryItem)
  .post("/stock/shopping-list/generate", authentication, stockInventory.generateShoppingList)
  .get("/stock/shopping-list", authentication, stockInventory.listShoppingList)
  .patch("/stock/shopping-list/:id/taken", authentication, stockInventory.setShoppingListTaken);

module.exports = routers;
