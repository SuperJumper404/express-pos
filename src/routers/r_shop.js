const { getShopInfo } = require("../controllers/c_shop");
const { authentication } = require("../helpers/middleware/auth");

const express = require("express");
const routers = express.Router();

routers.get(
  "/shopInfo",
  //   (req) => {
  //     console.log("HEADERS DEBUg", req.headers);
  //   },
  authentication,
  getShopInfo
);
// TODO modify shop info   .post("TOBEDEFINe", authentication, authAdmin, deleteUser);

module.exports = routers;
