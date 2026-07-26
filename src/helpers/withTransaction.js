const pool = require("../config/dbPool");

const createTransactionRunner = (sourcePool) => async (work) => {
  const connection = await sourcePool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

module.exports = {
  createTransactionRunner,
  withTransaction: createTransactionRunner(pool),
};
