const assert = require("assert");
const {
  buildModuleAuthorization,
} = require("../src/helpers/middleware/auth");

const responseRecorder = () => {
  const response = {};
  return {
    response,
    res: {
      status: (code) => {
        response.code = code;
        return {
          json: (body) => {
            response.body = body;
            return body;
          },
        };
      },
    },
  };
};

const runAuthorization = async (req, user) => {
  let nextCalls = 0;
  let lookups = 0;
  const middleware = buildModuleAuthorization({
    moduleKey: "stocks",
    findUserByIdAndShop: async () => {
      lookups += 1;
      return user;
    },
  });
  const { res, response } = responseRecorder();
  await middleware(req, res, () => { nextCalls += 1; });
  return { lookups, nextCalls, response };
};

(async () => {
  let result = await runAuthorization({
    sessionSubject: "staff", access: 0, id: 1, shopid: 7,
  });
  assert.strictEqual(result.nextCalls, 1);
  assert.strictEqual(result.lookups, 0);

  result = await runAuthorization(
    { sessionSubject: "staff", access: 1, id: 2, shopid: 7 },
    { id: 2, access: 1, status: 1, module_permissions: '["stocks"]' },
  );
  assert.strictEqual(result.nextCalls, 1);

  result = await runAuthorization(
    { sessionSubject: "staff", access: 1, id: 2, shopid: 7 },
    { id: 2, access: 1, status: 1, module_permissions: '["orders"]' },
  );
  assert.strictEqual(result.nextCalls, 0);
  assert.strictEqual(result.response.code, 403);

  result = await runAuthorization({
    sessionSubject: "service_point", access: 2, id: null, shopid: 7,
  });
  assert.strictEqual(result.nextCalls, 0);
  assert.strictEqual(result.response.code, 403);

  result = await runAuthorization({
    sessionSubject: "staff", access: 2, id: 3, shopid: 7,
  });
  assert.strictEqual(result.nextCalls, 0);
  assert.strictEqual(result.response.code, 403);

  const routerSource = require("fs").readFileSync(
    require.resolve("../src/routers/r_stockInventory"),
    "utf8",
  );
  const routeCount = (routerSource.match(/\.(?:get|post|patch|delete)\("\/stock/g) || []).length;
  const authorizationCount = (routerSource.match(/, authentication, authorizeStocks,/g) || []).length;
  assert.ok(routeCount >= 12);
  assert.strictEqual(authorizationCount, routeCount);

  const legacyRouterSource = require("fs").readFileSync(
    require.resolve("../src/routers/stocks"),
    "utf8",
  );
  const legacyRouteCount = (legacyRouterSource.match(/\.(?:get|post)\('\/(?:stocks|productstocks)/g) || []).length;
  const legacyAuthorizationCount = (
    legacyRouterSource.match(/, authentication, authorizeStocks,/g) || []
  ).length;
  assert.strictEqual(legacyAuthorizationCount, legacyRouteCount);

  console.log("stock authorization tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
