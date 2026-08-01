const assert = require("assert");

process.env.JWTKEY = process.env.JWTKEY || "test-secret";

const { signTableAccessToken, verifyTableAccessToken } = require("../src/helpers/tableAccessToken");
const { buildTableAccessLoginData } = require("../src/helpers/tableAccessLoginData");

const validUser = {
  id: 12,
  shopid: 8,
  username: "Table 1",
  email: "table-1-shop-8@tables.local",
  access: 2,
  status: 1,
};

const token = signTableAccessToken(validUser);
const decoded = verifyTableAccessToken(token);

const loginData = buildTableAccessLoginData({
  decoded,
  user: validUser,
  sessionToken: "session-token",
});

assert.deepStrictEqual(loginData[0], {
  id: 12,
  shopid: 8,
  username: "Table 1",
  email: "table-1-shop-8@tables.local",
  token: "session-token",
  expired: undefined,
  phone: undefined,
  gender: undefined,
  position: undefined,
  image: undefined,
  status: 1,
  access: 2,
  created: undefined,
  updated: undefined,
});

assert.throws(
  () =>
    buildTableAccessLoginData({
      decoded,
      user: { ...validUser, status: 0 },
      sessionToken: "session-token",
    }),
  /inactive/,
);

assert.throws(
  () =>
    buildTableAccessLoginData({
      decoded,
      user: { ...validUser, access: 1 },
      sessionToken: "session-token",
    }),
  /invalide/,
);

assert.throws(
  () =>
    buildTableAccessLoginData({
      decoded,
      user: { ...validUser, shopid: 99 },
      sessionToken: "session-token",
    }),
  /Restaurant/,
);

console.log("table access controller tests passed");
