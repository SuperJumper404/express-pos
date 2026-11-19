const assert = require('node:assert/strict')
const test = require('node:test')
const { buildServicePointsController } = require('../src/controllers/c_servicePoints')
const mockResponse = () => ({
  set() {}, status(code) { this.code = code; return this }, json(body) { this.body = body },
})
test('only an active display can read orders for the restaurant from its session', async () => {
  const shops = []
  let point = { type: 'call_display', is_active: 1 }
  const controller = buildServicePointsController({
    findServicePoint: async input => {
      assert.deepEqual(input, { shopId: 12, servicePointId: 42 })
      return point
    },
    listCallOrders: async id => { shops.push(id); return [] },
  })
  const request = { sessionSubject: 'service_point', orderSource: 'call_display',
    shopid: 12, servicePointId: 42, query: { shopid: 99 } }
  const call = async req => {
    const res = mockResponse()
    await controller.callOrders(req, res)
    return res.code
  }
  assert.equal(await call(request), 200)
  assert.equal(await call({ ...request, orderSource: 'borne' }), 403)
  point.is_active = 0
  assert.equal(await call(request), 403)
  point = null
  assert.equal(await call(request), 403)
  assert.deepEqual(shops, [12])
})
