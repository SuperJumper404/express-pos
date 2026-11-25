const {
  addProduct, 
  allProduct, 
  detailProduct,
  duplicateProduct,
  publicClickAndCollectProducts,
  reorderProducts,
  updateProductCustomizationConfig,
  updateProduct,
  deleteProduct
} = require('../controllers/c_products')
const { authentication, authAdmin } = require('../helpers/middleware/auth')
const singleUploadProductImg = require('../helpers/middleware/products')
const express = require('express')
const routers = express.Router()

routers
  .post('/product', authentication, authAdmin, singleUploadProductImg, addProduct)
  .post('/product/:id/duplicate', authentication, authAdmin, duplicateProduct)
  .get('/products/click-and-collect/:shopid', publicClickAndCollectProducts)
  .get('/products', authentication, allProduct)
  .patch('/products/order', authentication, authAdmin, reorderProducts)
  .get('/product/:id', authentication, detailProduct)
  .put('/products/:id/customization-config', authentication, authAdmin, updateProductCustomizationConfig)
  .patch('/product/:id', authentication, authAdmin, singleUploadProductImg, updateProduct)
  .delete('/product/:id', authentication, authAdmin, deleteProduct)

module.exports = routers
