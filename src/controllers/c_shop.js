const { mGetShopInfo } = require("../modules/m_shop");

const { custom, success, failed } = require("../helpers/response");
const response = require("../helpers/response");
exports.getShopInfo = async (req, res) => {
  mGetShopInfo(req.shopid)
    .then((response) => {
      console.log("Shop Info", response);
      success(res, "Shop Info", null, response);
    })
    .catch((error) => {
      console.log("Error On getting shop info");
      failed(res, "Error On getting shop info", error.message);
    });
};
