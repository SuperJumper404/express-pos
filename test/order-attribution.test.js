const assert = require("assert");

const callbackDbPath = require.resolve("../src/config/db");
require.cache[callbackDbPath] = {
  exports: { query: () => { throw new Error("unexpected legacy DB query"); } },
};

const { pickArchiveOrderFields } = require("../src/modules/m_orders");

assert.strictEqual(
  typeof pickArchiveOrderFields,
  "function",
  "archiving must copy the staff attribution fields",
);

assert.deepStrictEqual(
  pickArchiveOrderFields({
    shopid: 7,
    operator: 9,
    taken_by_user_id: 9,
    taken_by_name: "Amina",
    prepared_by_user_id: 11,
    prepared_by_name: "Leo",
  }),
  {
    shopid: 7,
    operator: 9,
    taken_by_user_id: 9,
    taken_by_name: "Amina",
    prepared_by_user_id: 11,
    prepared_by_name: "Leo",
  },
  "archived orders must keep staff attribution snapshots",
);

console.log("order attribution archive tests passed");
