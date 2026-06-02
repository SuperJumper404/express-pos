const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const routerUsers = require("./src/routers/r_users");
const routerProducts = require("./src/routers/r_products");
const routerCategory = require("./src/routers/r_category");
const routerStock = require("./src/routers/stocks");
const routerOrders = require("./src/routers/r_orders");
const routerShop = require("./src/routers/r_shop");
const routerPrinting = require("./src/routers/r_printing");
const routerStripe = require("./src/routers/r_stripe");
const { envPORT, envPUBLICIMAGEPATH } = require("./src/helpers/env");
const prefix = require("./src/config/prefix");

const fs = require("fs");

const productsPath = path.join(envPUBLICIMAGEPATH, "products");
const shopPath = path.join(envPUBLICIMAGEPATH, "shop");

if (!fs.existsSync(productsPath)) {
  fs.mkdirSync(productsPath, { recursive: true });
}
if (!fs.existsSync(shopPath)) {
  fs.mkdirSync(shopPath, { recursive: true });
}

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, Authentication",
  );
  next();
});
app.use(
  `${prefix}/stripe/webhook`,
  bodyParser.raw({ type: "application/json" }),
  routerStripe.webhookRouter,
);
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "1mb" }));
app.get(`${prefix}`, function (req, res) {
  res.json({ msg: "Hai" });
});
app.use(`${prefix}`, routerUsers);
app.use(`${prefix}`, routerProducts);
app.use(`${prefix}`, routerCategory);
app.use(`${prefix}`, routerStock);
app.use(`${prefix}`, routerOrders);
app.use(`${prefix}`, routerShop);
app.use(`${prefix}`, routerPrinting);
app.use(`${prefix}`, routerStripe.routers);
app.get(`${prefix}/testapi`, (req, res) => {
  res.json({ success: true, message: "API redirigée correctement 👌" });
});
console.log("Public Image Path:", envPUBLICIMAGEPATH);
app.use(
  "/api/v1/imgproducts",
  express.static(path.join(envPUBLICIMAGEPATH, "products")),
);

app.use(
  "/api/v1/imgprofile",
  express.static(path.join(envPUBLICIMAGEPATH, "shop")),
);
app.listen(envPORT, "0.0.0.0" || 5005, () => {
  console.log(`Server is running onn  http://localhosst:${envPORT || 5005}`);
});
