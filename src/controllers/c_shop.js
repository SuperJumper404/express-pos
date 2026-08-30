const {
  mGetShopInfo,
  mUpdateShopInfo,
  mCreateAndInitializeShop,
} = require("../modules/m_shop");
const { findSystemPoint } = require("../modules/m_servicePoints");

const { custom, success, failed } = require("../helpers/response");
const response = require("../helpers/response");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { normalizeQrPaymentMode } = require("../helpers/qrPaymentMode");
const { normalizeCommissionPercent } = require("../helpers/stripePayment");
const { normalizeDiscountPercentages } = require("../helpers/discount");
const {
  DEFAULT_SHOP_THEME,
  normalizeShopTheme,
} = require("../helpers/shopTheme");

const DEFAULT_SHOP_PAYMENT_METHODS = [
  "Tickets Restaurants",
  "Cheques",
  "Especes",
];
const DEFAULT_DISCOUNT_PERCENTAGES = [5, 10, 15, 20];

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

const parseStoredJson = (value, fallback) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
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
        `Champs requis manquants : ${missingFields.join(", ")}`,
        null,
        null,
      );
    }

    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(body.admin_password, salt);
    const created = new Date();

    const data = {
      shop_name: body.shop_name,
      shop_mail: body.shop_mail,
      shop_phone: body.shop_phone,
      shop_description: body.shop_description || "",
      shop_payment_methods: DEFAULT_SHOP_PAYMENT_METHODS,
      discount_percentages: DEFAULT_DISCOUNT_PERCENTAGES,
      shop_adress: body.shop_adress,
      shop_siret: body.shop_siret || null,
      shop_naf: body.shop_naf || null,
      shop_vat_number: body.shop_vat_number || null,
      receipt_review_qr_url: body.receipt_review_qr_url || null,
      receipt_review_qr_label: body.receipt_review_qr_label || null,
      cash_register_number: body.cash_register_number || null,
      admin_mail: body.admin_mail,
      admin_phone: body.admin_phone,
      admin_username: body.admin_username || "Administrateur",
      admin_password: hashedPassword,
      admin_password_clear: body.admin_password,
      hours: DEFAULT_SHOP_HOURS,
      shop_social_media: DEFAULT_SHOP_SOCIAL_MEDIA,
      shop_profile_image: body.shop_profile_image || "",
      shop_theme: DEFAULT_SHOP_THEME,
      shop_status: body.shop_status || "inactive",
      kitchen_closed: 0,
      shop_printer_ip: body.shop_printer_ip || "",
      smart_print_app: 1,
      auto_print_order_tickets: 0,
      stripe_commission_percent: normalizeCommissionPercent(
        body.stripe_commission_percent,
      ),
      created,
    };

    const createdShop = await mCreateAndInitializeShop(data);

    success(
      res,
      "Boutique créée et initialisée avec succès.",
      null,
      createdShop,
    );
  } catch (error) {
    failed(res, "Erreur lors de la création et de l'initialisation de la boutique.", error.message);
  }
};

exports.getShopInfo = async (req, res) => {
  mGetShopInfo(req.shopid)
    .then((response) => {
      console.log("Shop Info", response);
      success(res, "Informations boutique récupérées.", null, response);
    })
    .catch((error) => {
      console.log("Error On getting shop info");
      failed(res, "Erreur lors de la récupération des informations boutique.", error.message);
    });
};

exports.getShopInfoClickAndCollect = async (req, res) => {
  try {
    const shopid = req.params.shopid;
    const response = await mGetShopInfo(shopid);
    const clickAndCollectServicePoint = await findSystemPoint({
      shopId: shopid,
      systemKey: "click_collect",
    });

    const data = {
      shop_name: response?.[0]?.shop_name,
      shop_mail: response?.[0]?.shop_mail,
      shop_phone: response?.[0]?.shop_phone,
      shop_adress: response?.[0]?.shop_adress,
      shop_description: response?.[0]?.shop_description,
      shop_payment_methods: response?.[0]?.shop_payment_methods,
      discount_percentages: response?.[0]?.discount_percentages,
      shop_siret: response?.[0]?.shop_siret,
      shop_naf: response?.[0]?.shop_naf,
      shop_vat_number: response?.[0]?.shop_vat_number,
      receipt_review_qr_url: response?.[0]?.receipt_review_qr_url,
      receipt_review_qr_label: response?.[0]?.receipt_review_qr_label,
      cash_register_number: response?.[0]?.cash_register_number,
      hours: response?.[0]?.hours,
      shop_social_media: response?.[0]?.shop_social_media,
      shop_status: response?.[0]?.shop_status,
      kitchen_closed: response?.[0]?.kitchen_closed,
      shop_profile_image: response?.[0]?.shop_profile_image,
      shop_theme: response?.[0]?.shop_theme,
      shop_printer_ip: response?.[0]?.shop_printer_ip,
      smart_print_app: response?.[0]?.smart_print_app,
      auto_print_order_tickets: response?.[0]?.auto_print_order_tickets,
      qr_payment_mode: normalizeQrPaymentMode(response?.[0]?.qr_payment_mode),
      stripe_charges_enabled: response?.[0]?.stripe_charges_enabled,
      stripe_onboarding_complete: response?.[0]?.stripe_onboarding_complete,
      clickAndCollectServicePoint: clickAndCollectServicePoint
        ? {
            id: clickAndCollectServicePoint.id,
            name: clickAndCollectServicePoint.name,
          }
        : null,
    };

    // Une seule réponse HTTP
    success(res, "Informations click and collect récupérées.", null, data);
  } catch (error) {
    console.log("Error On getting shop info click and collect", error);
    failed(res, "Erreur lors de la récupération des informations click and collect.", error.message);
  }
};

exports.setShopInfo = async (req, res) => {
  console.log("Set Shop ", req.body);
  console.log("Set Shop ", req);
  console.log("Set Shop ", JSON.stringify(req.body));
  try {
    await mUpdateShopInfo(req.body, req.shopid);
    success(res, "Informations boutique mises à jour.", null, null);
  } catch (error) {
    failed(res, "Erreur lors de la mise à jour des informations boutique.", error.message);
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
    const preferOptional = (value, fallback) =>
      value === undefined ? fallback : value === "" ? null : value;

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
      shop_naf: preferOptional(req.body.shop_naf, shopInfo.shop_naf),
      shop_vat_number: preferOptional(
        req.body.shop_vat_number,
        shopInfo.shop_vat_number,
      ),
      receipt_review_qr_url: preferOptional(
        req.body.receipt_review_qr_url,
        shopInfo.receipt_review_qr_url,
      ),
      receipt_review_qr_label: preferOptional(
        req.body.receipt_review_qr_label,
        shopInfo.receipt_review_qr_label,
      ),
      cash_register_number: preferOptional(
        req.body.cash_register_number,
        shopInfo.cash_register_number,
      ),
      activate_tva: prefer(req.body.activate_tva, shopInfo.activate_tva),
      hours: prefer(
        req.body.shop_hours,
        parseStoredJson(shopInfo.hours, DEFAULT_SHOP_HOURS),
      ),
      shop_social_media: prefer(
        req.body.shop_social_media,
        parseStoredJson(shopInfo.shop_social_media, DEFAULT_SHOP_SOCIAL_MEDIA),
      ),

      shop_payment_methods: prefer(
        req.body.shop_payment_methods,
        parseStoredJson(shopInfo.shop_payment_methods, DEFAULT_SHOP_PAYMENT_METHODS),
      ),
      discount_percentages: normalizeDiscountPercentages(
        parseStoredJson(
          prefer(req.body.discount_percentages, shopInfo.discount_percentages),
          DEFAULT_DISCOUNT_PERCENTAGES,
        ),
      ),
      shop_profile_image: req.file?.filename || shopInfo.shop_profile_image,
      shop_theme: normalizeShopTheme(
        prefer(req.body.shop_theme, shopInfo.shop_theme),
      ),
      shop_status: prefer(req.body.shop_status, shopInfo.shop_status),
      kitchen_closed: prefer(req.body.kitchen_closed, shopInfo.kitchen_closed || 0),
      shop_printer_ip: prefer(req.body.shop_printer_ip, shopInfo.shop_printer_ip),
      smart_print_app: prefer(req.body.smart_print_app, shopInfo.smart_print_app),
      auto_print_order_tickets: prefer(
        req.body.auto_print_order_tickets,
        shopInfo.auto_print_order_tickets || 0,
      ),
      qr_payment_mode: normalizeQrPaymentMode(
        prefer(req.body.qr_payment_mode, shopInfo.qr_payment_mode),
      ),
      stripe_commission_percent: normalizeCommissionPercent(
        prefer(
          req.body.stripe_commission_percent,
          shopInfo.stripe_commission_percent,
        ),
      ),
      stripe_account_id: shopInfo.stripe_account_id,
      stripe_onboarding_complete: shopInfo.stripe_onboarding_complete,
      stripe_charges_enabled: shopInfo.stripe_charges_enabled,
      stripe_payouts_enabled: shopInfo.stripe_payouts_enabled,
    };
    console.log("Full Shop Data", data);
    await mUpdateShopInfo(data, req.shopid);
    success(res, "Informations boutique mises à jour.", null, null);
  } catch (error) {
    failed(res, "Erreur lors de la mise à jour des informations boutique.", error.message);
  }
};
