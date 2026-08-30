const RETRYABLE_DATABASE_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "PROTOCOL_CONNECTION_LOST",
  "ER_SERVER_SHUTDOWN",
]);

const sleep = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

const waitForDatabase = async ({
  checkConnection,
  delayMs = 1000,
  retries = 60,
  logger = console,
} = {}) => {
  if (typeof checkConnection !== "function") {
    throw new TypeError("checkConnection must be a function");
  }

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await checkConnection();
      return true;
    } catch (error) {
      lastError = error;
      const retryable = RETRYABLE_DATABASE_ERRORS.has(error && error.code);
      if (!retryable || attempt === retries) throw error;

      logger.warn(
        `Database indisponible (${error.code || error.message}), nouvelle tentative ${attempt}/${retries}.`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
};

module.exports = {
  RETRYABLE_DATABASE_ERRORS,
  waitForDatabase,
};
