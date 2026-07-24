const {
  addProduct, 
  allProduct, 
  detailProduct,
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
  .get('/products', authentication, allProduct)
  .get('/product/:id', authentication, detailProduct)
  .put('/products/:id/customization-config', authentication, authAdmin, updateProductCustomizationConfig)
  .patch('/product/:id', authentication, authAdmin, singleUploadProductImg, updateProduct)
  .delete('/product/:id', authentication, authAdmin, deleteProduct)

module.exports = routers
