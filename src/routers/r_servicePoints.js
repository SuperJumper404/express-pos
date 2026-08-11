const express = require("express");
const {
  listPoints,
  listTables,
  createTable,
  updateTable,
  deleteTable,
} = require("../controllers/c_servicePoints");
const { authentication, authAdmin } = require("../helpers/middleware/auth");

const routers = express.Router();

routers
  .get("/service-points", authentication, listPoints)
  .get("/service-points/tables", authentication, listTables)
  .post("/service-points/tables", authentication, authAdmin, createTable)
  .patch("/service-points/tables/:id", authentication, authAdmin, updateTable)
  .delete("/service-points/tables/:id", authentication, authAdmin, deleteTable);

module.exports = routers;
