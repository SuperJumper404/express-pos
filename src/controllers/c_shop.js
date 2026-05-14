const {
  mGetShopInfo,
  mUpdateShopInfo,
  mCreateAndInitializeShop,
} = require("../modules/m_shop");
const { mGetAllUser } = require("../modules/m_users");

const { custom, success, failed } = require("../helpers/response");
const response = require("../helpers/response");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { nanoid } = require("nanoid");

const DEFAULT_SHOP_PAYMENT_METHODS = [
  "Tickets Restaurants",
  "Cheques",
  "Especes",
];

const DEFAULT_SHOP_HOURS = [
  { dayName: "Lundi", isOpen: true, from: 8, to: 20 },
  { dayName: "Mardi", isOpen: true, from: 8, to: 20 },
  { dayName: "Mercredi", isOpen: false, from: 8, to: 20 },
  { dayName: "Jeudi", isOpen: true, from: 8, to: "19" },
  { dayName: "Vendredi", isOpen: true, from: 8, to: 20 },
  { dayName: "Samedi", isOpen: true, from: 8, to: "19" },
  { dayName: "Dimanche", isOpen: true, from: 0, to: 0 },
];

const DEFAULT_SHOP_SOCIAL_MEDIA = {
  instagram: "https://www.instagram.com/",
  snapchat: "https://www.snapchat.com/",
  facebook: "https://www.facebook.com/",
  tiktok: "https://www.tiktok.com/",
  twitter: "",
};

exports.getCreateShopBackoffice = (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/backoffice/shop-init.html"));
};

exports.createAndInitializeShop = async (req, res) => {
  try {
    const body = req.body || {};
    const requiredFields = [
      "shop_name",
      "shop_mail",
      "shop_phone",
      "shop_adress",
      "admin_mail",
      "admin_phone",
      "admin_password",
    ];

    const missingFields = requiredFields.filter((field) => {
      const value = body[field];
      return value === undefined || value === null || value === "";
    });

    if (missingFields.length > 0) {
      return custom(
        res,
        422,
        `Missing required fields: ${missingFields.join(", ")}`,
        null,
        null,
      );
    }

    const shopNameWithoutSpaces = String(body.shop_name).replace(/\s+/g, "");
    const clickAndCollectEmail = `${nanoid()}@${shopNameWithoutSpaces}.fr`;
    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(body.admin_password, salt);
    const created = new Date();

    const data = {
      shop_name: body.shop_name,
      shop_mail: body.shop_mail,
      shop_phone: body.shop_phone,
      shop_description: body.shop_description || "",
      shop_payment_methods: DEFAULT_SHOP_PAYMENT_METHODS,
      shop_adress: body.shop_adress,
      shop_siret: body.shop_siret || null,
      admin_mail: body.admin_mail,
      admin_phone: body.admin_phone,
      admin_password: hashedPassword,
      admin_password_clear: body.admin_password,
      click_and_collect_email: clickAndCollectEmail,
      click_and_collect_password: hashedPassword,
      click_and_collect_clearpass: body.admin_password,
      hours: DEFAULT_SHOP_HOURS,
      shop_social_media: DEFAULT_SHOP_SOCIAL_MEDIA,
      shop_profile_image: body.shop_profile_image || "",
      shop_status: body.shop_status || "inactive",
      shop_printer_ip: body.shop_printer_ip || "",
      smart_print_app: 1,
      created,
    };

    const createdShop = await mCreateAndInitializeShop(data);

    success(
      res,
      "Shop created and initialized successfully",
      null,
      createdShop,
    );
  } catch (error) {
    failed(res, "Error while creating and initializing shop", error.message);
  }
};

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
  try {
    const shopid = req.params.shopid;

    // 1) appel users
    const users = await mGetAllUser(shopid);
    console.log("Users", users);
    const clickAndCollectTable = users.find((user) => user.access === 3);
    console.log("clickAndCollectTable", clickAndCollectTable);
    // 2) appel shop info
    const response = await mGetShopInfo(shopid);

    const data = {
      shop_name: response?.[0]?.shop_name,
      shop_mail: response?.[0]?.shop_mail,
      shop_phone: response?.[0]?.shop_phone,
      shop_adress: response?.[0]?.shop_adress,
      shop_description: response?.[0]?.shop_description,
      shop_payment_methods: response?.[0]?.shop_payment_methods,
      shop_siret: response?.[0]?.shop_siret,
      hours: response?.[0]?.hours,
      shop_social_media: response?.[0]?.shop_social_media,
      shop_status: response?.[0]?.shop_status,
      shop_profile_image: response?.[0]?.shop_profile_image,
      shop_printer_ip: response?.[0]?.shop_printer_ip,
      smart_print_app: response?.[0]?.smart_print_app,
      clickAndCollectTable: {
        email: clickAndCollectTable?.email || "",
        clearpass: clickAndCollectTable?.clearpass || "",
      },
    };

    // Une seule réponse HTTP
    success(res, "Shop Info Click and collect", null, data);
  } catch (error) {
    console.log("Error On getting shop info click and collect", error);
    failed(res, "Error On getting shop info click and collect", error.message);
  }
};

exports.setShopInfo = async (req, res) => {
  console.log("Set Shop ", req.body);
  console.log("Set Shop ", req);
  console.log("Set Shop ", JSON.stringify(req.body));
  try {
    await mUpdateShopInfo(req.body, req.shopid);
    success(res, "Shop info updated", null, null);
  } catch (error) {
    failed(res, "Error On updating shop info", error.message);
  }
};

exports.updateShopInfo = async (req, res) => {
  try {
    console.log("Set Shop ", req.body);
    const rows = await mGetShopInfo(req.shopid);
    const shopInfo = rows[0];
    if (!shopInfo) {
      return custom(res, 404, "Shop introuvable.", null, null);
    }
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

    console.log(
      "Payment Methods",
      req.body.shop_payment_methods,
      shopInfo.shop_payment_methods,
    );
    const data = {
      shop_name: prefer(req.body.shop_name, shopInfo.shop_name),
      shop_description: prefer(
        req.body.shop_description,
        shopInfo.shop_description,
      ),
      shop_phone: prefer(req.body.shop_phone, shopInfo.shop_phone),
      shop_adress: prefer(req.body.shop_adress, shopInfo.shop_adress),
      shop_siret: prefer(req.body.shop_siret, shopInfo.shop_siret),
      activate_tva: prefer(req.body.activate_tva, shopInfo.activate_tva),
      hours: prefer(
        req.body.shop_hours,
        JSON.parse(JSON.stringify(shopInfo.hours)),
      ),
      shop_social_media: prefer(
        req.body.shop_social_media,
        JSON.parse(JSON.stringify(shopInfo.shop_social_media)),
      ),

      shop_payment_methods: prefer(
        req.body.shop_payment_methods,
        JSON.parse(JSON.stringify(shopInfo.shop_payment_methods)),
      ),
      shop_profile_image: req.file?.filename || shopInfo.shop_profile_image,
      shop_status: prefer(req.body.shop_status, shopInfo.shop_status),
      shop_printer_ip: prefer(req.body.shop_printer_ip, shopInfo.shop_printer_ip),
      smart_print_app: prefer(req.body.smart_print_app, shopInfo.smart_print_app),
    };
    console.log("Full Shop Data", data);
    await mUpdateShopInfo(data, req.shopid);
    success(res, "Shop info updated", null, null);
  } catch (error) {
    failed(res, "Error On updating shop info", error.message);
  }
};
