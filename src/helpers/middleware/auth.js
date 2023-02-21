const { custom } = require('../response')
const jwt = require('jsonwebtoken')
const { envJWTKEY } = require('../env')
console.log("Secret Key JWt", envJWTKEY);
module.exports = {
  authentication: (req, res, next) => {
    const authorization = req.headers.authorization
    if (authorization) {
      let token = authorization.split(" ")
      jwt.verify(token[1], envJWTKEY, (error, decoded) => {
        console.log("Incomiing ",decoded)
        if (!error) {
          res.access = decoded.access
          next()
        } else {
          if (error.name === 'JsonWebTokenError') {
            custom(res, 401, '', {}, error)
          } else {
            custom(res, 401,  'Token expaired!', {}, error)
          }
        }
      })
    } else {
      custom(res, 401, 'Token required!', {}, null)
    }
  },
  authAdmin: (req, res, next) => {
    // console.log("Incomiing rqg ",req)

    const access = res.access
    if (access === 0) {
      console.log("Je passe")
      next()
    } else {
      custom(res, 401, 'Access denied!, Only for admin', {}, null)
    }
  },
  authCashier: (req, res, next) => {
    const access = res.access
    if (access === 1) {
      next()
    } else {
      custom(res, 401, 'Access denied!, Only for cashier', {}, null)
    }
  },
  authCustomer: (req, res, next) => {
    const access = res.access
    if (access === 2) {
      next()
    } else {
      custom(res, 401, 'Access denied!, Only for customer', {}, null)
    }
  }
}