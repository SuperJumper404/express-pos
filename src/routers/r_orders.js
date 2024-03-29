const orders = require("../controllers/c_orders");
const { authentication } = require("../helpers/middleware/auth");
const express = require("express");
const routers = express.Router();

routers
  .get("/orders", authentication, orders.allOrder)
  .get("/detailorder/:id", authentication, orders.detailOrder)
  .post("/orders", authentication, orders.addOrder)
  .post("/detailorder", authentication, orders.addDetailOrder)
  .patch("/orders/:id", authentication, orders.updateOrder)
  .post("/orders/delete/:id", authentication, orders.deleteOrder)
  .get("/ordersbyUserId", authentication, orders.ordersbyUserId)
  .post("/orders/archive/:id", authentication, orders.archiveOrder);

module.exports = routers;
