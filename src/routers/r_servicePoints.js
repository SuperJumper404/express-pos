const express = require("express");
const {
  listPoints,
  listTables,
  listKiosks,
  createTable,
  createKiosk,
  updateTable,
  reorderTables,
  updateKiosk,
  regenerateKioskCredentials,
  deleteTable,
  createTableAccessSession,
} = require("../controllers/c_servicePoints");
const { authentication, authAdmin } = require("../helpers/middleware/auth");

const routers = express.Router();

routers
  .post("/table-access", createTableAccessSession)
  .get("/service-points", authentication, listPoints)
  .get("/service-points/tables", authentication, listTables)
  .get("/service-points/kiosks", authentication, authAdmin, listKiosks)
  .post("/service-points/tables", authentication, authAdmin, createTable)
  .post("/service-points/kiosks", authentication, authAdmin, createKiosk)
  .patch("/service-points/tables/order", authentication, authAdmin, reorderTables)
  .patch("/service-points/tables/:id", authentication, authAdmin, updateTable)
  .patch("/service-points/kiosks/:id", authentication, authAdmin, updateKiosk)
  .patch("/service-points/kiosks/:id/credentials", authentication, authAdmin, regenerateKioskCredentials)
  .delete("/service-points/tables/:id", authentication, authAdmin, deleteTable);

module.exports = routers;
