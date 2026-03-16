const {
  mAddProduct,
  mAllProduct,
  mDetailProduct,
  mUpdateProduct,
  mDeleteProduct,
  mUsedProduct,
  mArchiveProduct,
} = require("../modules/m_products");
const path = require("path");
const { envPUBLICIMAGEPATH } = require("../helpers/env");
const { success, custom, failed } = require("../helpers/response");
const fs = require("fs");

module.exports = {
  addProduct: (req, res) => {
    console.log("New Product To Add  ", req.body.product_customization);
    const body = req.body;
    if (body.product_customization) {
      body.product_customization = JSON.parse(body.product_customization);
    }
    body.image = req.file.filename;
    body.shopid = req.shopid;
    body.created = new Date();
    if (!body.name || !body.categoryid || !body.price || !body.stock) {
      const locationPath = path.join(
        envPUBLICIMAGEPATH,
        "products",
        req.file.filename,
      );
      fs.unlinkSync(locationPath);
      custom(res, 400, "Bad request", {}, null);
    } else {
      mAddProduct(body)
        .then(() => {
          custom(res, 200, "Create product success!", {}, null);
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    }
  },
  allProduct: async (req, res) => {
    mAllProduct(req.shopid)
      .then((response) => {
        success(res, "Get all data user", null, response);
      })
      .catch((error) => {
        console.log("erreurezrz");
        failed(res, "Internal server error!", error.message);
      });
  },
  detailProduct: (req, res) => {
    const id = req.params.id;
    mDetailProduct(id)
      .then((response) => {
        if (response.length > 0) {
          success(res, "Detail product!", null, response);
        } else {
          custom(res, 404, "Id product not found!", null, []);
        }
      })
      .catch((error) => {
        failed(res, "Internal server error!", error.message);
      });
  },
  updateProduct: async (req, res) => {
    const body = req.body;
    body.updated = new Date();
    const id = req.params.id;
    const detail = await mDetailProduct(id);
    if (req.file) {
      body.image = req.file.filename;
      const path = path.join(envPUBLICIMAGEPATH, "products", detail[0].image);
      if (fs.existsSync(path)) {
        try {
          fs.unlinkSync(path);
        } catch (err) {
          console.error(err);
        }
      }
      mUpdateProduct(body, id)
        .then(() => {
          success(res, "Update image product success!", {}, null);
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    } else {
      mUpdateProduct(body, id)
        .then(() => {
          success(res, "Update product success!", {}, null);
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    }
  },
  deleteProduct: async (req, res) => {
    try {
      const id = req.params.id;
      const callDetail = await mDetailProduct(id);
      const isUsedProduct = await mUsedProduct(id);
      console.log("isUsedProduct", isUsedProduct);
      if (isUsedProduct[0].cnt > 0) {
        console.log("Product used, archive it", id);
        await mArchiveProduct(id)
          .then(() => {
            success(res, "Archive product success!", {}, null);
          })
          .catch((error) => {
            failed(res, "Internal server error!", error.message);
          });
      } else {
        console.log("Product not used, delete it", id);
        mDeleteProduct(id)
          .then((response) => {
            if (response.affectedRows) {
              const locationPath = path.join(
                envPUBLICIMAGEPATH,
                "products",
                callDetail[0].image,
              );
              fs.unlinkSync(locationPath);
              success(res, "Delete product success!", {}, null);
            } else {
              custom(res, 404, "Id product not found!", null, null);
            }
          })
          .catch((error) => {
            failed(res, "Internal server error!", error.message);
          });
      }
    } catch (error) {
      failed(res, "Internal server error!", error.message);
    }
  },
};
