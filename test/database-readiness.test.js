const assert = require("assert");
const { waitForDatabase } = require("../src/helpers/waitForDatabase");

(async () => {
  let attempts = 0;
  const warnings = [];

  await waitForDatabase({
    checkConnection: async () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("connect ECONNREFUSED");
        error.code = "ECONNREFUSED";
        throw error;
      }
    },
    delayMs: 0,
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.strictEqual(attempts, 3);
  assert.strictEqual(warnings.length, 2);

  await assert.rejects(
    () => waitForDatabase({
      checkConnection: async () => {
        const error = new Error("access denied");
        error.code = "ER_ACCESS_DENIED_ERROR";
        throw error;
      },
      delayMs: 0,
      retries: 2,
      logger: { warn: () => {} },
    }),
    /access denied/
  );

  console.log("database readiness tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
