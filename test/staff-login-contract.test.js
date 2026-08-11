const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const controller = fs.readFileSync(
  path.join(root, 'src', 'controllers', 'c_users.js'),
  'utf8'
)
const moduleSource = fs.readFileSync(
  path.join(root, 'src', 'modules', 'm_users.js'),
  'utf8'
)
const router = fs.readFileSync(
  path.join(root, 'src', 'routers', 'r_users.js'),
  'utf8'
)

assert.match(controller, /verifyStaffPin/)
assert.match(controller, /regenerate_login_id/)
assert.match(controller, /Number\(user\.access\)\s*===\s*0/)
assert.match(moduleSource, /WHERE staff_login_id = \?/) 
assert.match(moduleSource, /staff_login_id/)
assert.doesNotMatch(moduleSource, /SELECT \* FROM users WHERE shopid = \?/) 
assert.doesNotMatch(moduleSource, /staff_pin_hash.*mGetAllUser/) 

const credentialRoute = router.indexOf('/user/:id/staff-credentials')
const genericUpdateRoute = router.indexOf('.patch("/user/:id"')

assert.ok(credentialRoute >= 0, 'credential reset route must exist')
assert.ok(
  credentialRoute < genericUpdateRoute,
  'credential reset route must be registered before generic user update'
)
assert.match(router, /setStaffCredentials/)

console.log('staff login contract tests passed')
