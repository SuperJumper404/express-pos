const {
  mAddProduct,
  mAllProduct,
  mDetailProduct,
  mUpdateProduct,
  mDeleteProduct,
} = require("../modules/m_products");
const { success, custom, failed } = require("../helpers/response");
const fs = require("fs");

module.exports = {
  addProduct: (req, res) => {
    const body = req.body;
    body.image = req.file.filename;
    if (!body.name || !body.categoryid || !body.price || !body.stock) {
      const locationPath = `./public/products/${req.file.filename}`;
      fs.unlinkSync(locationPath);
      custom(res, 400, "Bad request", {}, null);
    } else {
      mAddProduct(body)
        .then(() => {
          custom(res, 201, "Create product success!", {}, null);
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    }
  },
  allProduct: async (req, res) => {
    mAllProduct()
      .then((response) => {
        console.log("normiou");
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
      const path = `./public/products/${detail[0].image}`;
      if (fs.existsSync(path)) {
        fs.unlinkSync(path);
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
      mDeleteProduct(id)
        .then((response) => {
          if (response.affectedRows) {
            const locationPath = `./public/products/${callDetail[0].image}`;
            fs.unlinkSync(locationPath);
            success(res, "Delete product success!", {}, null);
          } else {
            custom(res, 404, "Id product not found!", null, null);
          }
        })
        .catch((error) => {
          failed(res, "Internal server error!", error.message);
        });
    } catch (error) {
      failed(res, "Internal server error!", error.message);
    }
  },
};
