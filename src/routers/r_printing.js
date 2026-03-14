const { addPrintingJob, getPrintingJob } = require("../controllers/c_printing");
const { authentication } = require("../helpers/middleware/auth");

const express = require("express");
const routers = express.Router();

routers
  .post("/pushprintingjob/", authentication, addPrintingJob)
  .post("/pullprintingjob", getPrintingJob);

module.exports = routers;
