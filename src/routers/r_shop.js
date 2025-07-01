const { getShopInfo, setShopInfo } = require("../controllers/c_shop");
const { authentication, authAdmin } = require("../helpers/middleware/auth");

const express = require("express");
const singleUploadShopImg = require("../helpers/middleware/shop");
const routers = express.Router();

routers.get("/shopInfo", authentication, authAdmin, getShopInfo);

routers.patch(
  "/setShopInfo",
  authentication,
  authAdmin,
  singleUploadShopImg,
  setShopInfo
);
// TODO modify shop info   .post("TOBEDEFINe", authentication, authAdmin, deleteUser);

module.exports = routers;
