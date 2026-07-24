const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { withTransaction } = require("../helpers/withTransaction");

const ALLOWED = new Set(["1:2", "2:3", "1:4", "2:4"]);

const queryResult = async (connection, sql, params = []) => {
  const [result] = await (connection || pool).query(sql, params);
  return result;
};

const sqlRepository = {
  lockOrder: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT * FROM orders
     WHERE id = ? AND shopid = ?
     LIMIT 1 FOR UPDATE`,
    [orderId, shopId],
  ).then((rows) => rows[0] || null),
  updateStatus: ({ orderId, shopId, actorId, nextStatus, finished, connection }) => (
    queryResult(
      connection,
      `UPDATE orders
       SET status = ?, operator = ?, finished = ?
       WHERE id = ? AND shopid = ?`,
      [nextStatus, actorId, finished, orderId, shopId],
    )
  ),
};

const buildOrderTransitionModule = ({
  repository = sqlRepository,
  withTransaction: runInTransaction = withTransaction,
  now = () => new Date(),
} = {}) => {
  const transitionOrderStatus = async ({
    orderId, shopId, actorId, nextStatus,
  }) => runInTransaction(async (connection) => {
    const order = await repository.lockOrder({ orderId, shopId, connection });
    if (!order) {
      throw new DomainError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
    }
    if (!ALLOWED.has(`${Number(order.status)}:${Number(nextStatus)}`)) {
      throw new DomainError(
        422,
        "ORDER_STATUS_TRANSITION_INVALID",
        "Changement de statut non autorisé pour cette commande.",
      );
    }
    const result = await repository.updateStatus({
      orderId,
      shopId,
      actorId,
      nextStatus,
      finished: now().toISOString().slice(0, 19).replace("T", " "),
      connection,
    });
    return { order, result };
  });

  return { transitionOrderStatus };
};

const orderTransitionModule = buildOrderTransitionModule();

module.exports = {
  ALLOWED,
  buildOrderTransitionModule,
  transitionOrderStatus: orderTransitionModule.transitionOrderStatus,
};
