const assert = require("assert");
const { createTransactionRunner } = require("../src/helpers/withTransaction");

const calls = [];
const connection = {
  beginTransaction: async () => calls.push("begin"),
  commit: async () => calls.push("commit"),
  rollback: async () => calls.push("rollback"),
  release: () => calls.push("release"),
};
const pool = { getConnection: async () => connection };

(async () => {
  const run = createTransactionRunner(pool);
  const value = await run(async (conn) => {
    assert.strictEqual(conn, connection);
    return 42;
  });
  assert.strictEqual(value, 42);
  assert.deepStrictEqual(calls, ["begin", "commit", "release"]);

  calls.length = 0;
  await assert.rejects(() => run(async () => { throw new Error("boom"); }), /boom/);
  assert.deepStrictEqual(calls, ["begin", "rollback", "release"]);
  console.log("transaction helper tests passed");
})();
