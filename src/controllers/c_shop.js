const { mGetShopInfo, mUpdateShopInfo } = require("../modules/m_shop");

const { custom, success, failed } = require("../helpers/response");
const response = require("../helpers/response");
const fs = require("fs");
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

exports.getShopInfoClickAndCollect = async (req, res) => {
  mGetShopInfo(req.params.shopid)
    .then((response) => {
      const shopInfo = {
        shop_name: response[0].shop_name,
        shop_mail: response[0].shop_mail,
        shop_phone: response[0].shop_phone,
        shop_adress: response[0].shop_adress,
        shop_description: response[0].shop_description,
        shop_payment_methods: response[0].shop_payment_methods,
        hours: response[0].hours,
        shop_status: response[0].shop_status,
        shop_profile_image: response[0].shop_profile_image,
        shop_printer_ip: response[0].shop_printer_ip,
      };
      console.log("Shop Info CLick and collect", shopInfo);
      success(res, "Shop Info", null, shopInfo);
    })
    .catch((error) => {
      console.log("Error On getting shop info");
      failed(res, "Error On getting shop info", error.message);
    });
};

exports.setShopInfo = async (req, res) => {
  console.log("Set Shop ", req.body);
  console.log("Set Shop ", req);
  console.log("Set Shop ", JSON.stringify(req.body));
  failed(res, "Error On getting shop info");

  // mUpdateShopInfo(req.body, req.shopid);
};

exports.updateShopInfo = async (req, res) => {
  console.log("Set Shop ", req.body);
  const rows = await mGetShopInfo(req.shopid);
  const shopInfo = rows[0];
  console.log("shopInof", shopInfo);
  console.log("Filename", req.file);
  if (req.file && req.file.filename !== shopInfo.shop_profile_image) {
    console.log("Nouveau file name");
    if (shopInfo.shop_profile_image !== "") {
      const path = `./public/profile/${shopInfo.shop_profile_image}`;
      if (fs.existsSync(path)) {
        console.log("Ancienne IMG supprimer ", path);
        fs.unlinkSync(path);
      }
    }
  }
  const prefer = (value, fallback) => {
    console.log(" EQ", value, fallback);
    return value !== undefined && value !== "" ? value : fallback;
  };

  const data = {
    shop_name: prefer(req.body.shop_name, shopInfo.shop_name),
    shop_description: prefer(
      req.body.shop_description,
      shopInfo.shop_description
    ),
    shop_phone: prefer(req.body.shop_phone, shopInfo.shop_phone),
    shop_adress: prefer(req.body.shop_adress, shopInfo.shop_adress),
    hours: prefer(req.body.shop_hours, shopInfo.hours),
    shop_payment_methods: prefer(
      req.body.shop_payment_methods,
      shopInfo.shop_payment_methods
    ),
    shop_profile_image: req.file?.filename || shopInfo.shop_profile_image,
    shop_status: prefer(req.body.shop_status, shopInfo.shop_status),
    shop_printer_ip: prefer(req.body.shop_printer_ip, shopInfo.shop_printer_ip),
  };
  console.log("Full Shop Data", data);
  mUpdateShopInfo(data, req.shopid);
  // console.log("Set Shop ", req);//
  // console.log("Set Shop ", JSON.stringify(req.body));
  failed(res, "Error On getting shop info");
};
