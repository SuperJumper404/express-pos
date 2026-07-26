const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { ORDER_STATUSES } = require("../helpers/orderStatus");
const { withTransaction } = require("../helpers/withTransaction");

const ALLOWED_TRANSITIONS = new Set([
  `${ORDER_STATUSES.PENDING}:${ORDER_STATUSES.PREPARING}`,
  `${ORDER_STATUSES.PREPARING}:${ORDER_STATUSES.FINISHED}`,
  `${ORDER_STATUSES.PENDING}:${ORDER_STATUSES.CANCELED}`,
  `${ORDER_STATUSES.PREPARING}:${ORDER_STATUSES.CANCELED}`,
]);

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
  updateStatus: ({
    orderId, shopId, operator, nextStatus, finished, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET status = ?, operator = ?, finished = ?
     WHERE id = ? AND shopid = ?`,
    [nextStatus, operator, finished, orderId, shopId],
  ),
};

const formatDate = (value) => value.toISOString().slice(0, 19).replace("T", " ");

const assertOrderStatusTransition = (order, nextStatus) => {
  if (!ALLOWED_TRANSITIONS.has(`${Number(order.status)}:${Number(nextStatus)}`)) {
    throw new DomainError(
      422,
      "ORDER_STATUS_TRANSITION_INVALID",
      "Changement de statut non autorisé pour cette commande.",
    );
  }
};

const buildOrderTransitionModule = ({
  repository = sqlRepository,
  withTransaction: runInTransaction = withTransaction,
  now = () => new Date(),
} = {}) => {
  const transitionOrderStatus = ({
    orderId, shopId, nextStatus, operator, beforeTransition,
  }) => (
    runInTransaction(async (connection) => {
      const order = await repository.lockOrder({ orderId, shopId, connection });
      if (!order) {
        throw new DomainError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
      }
      assertOrderStatusTransition(order, nextStatus);
      if (beforeTransition) {
        await beforeTransition({ order, connection });
      }
      const result = await repository.updateStatus({
        orderId,
        shopId,
        operator,
        nextStatus,
        finished: formatDate(now()),
        connection,
      });
      return { order, result };
    })
  );

  return { transitionOrderStatus };
};

const orderTransitionModule = buildOrderTransitionModule();

module.exports = {
  ALLOWED_TRANSITIONS,
  assertOrderStatusTransition,
  buildOrderTransitionModule,
  transitionOrderStatus: orderTransitionModule.transitionOrderStatus,
};
