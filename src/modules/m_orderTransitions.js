const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { ORDER_STATUSES } = require("../helpers/orderStatus");
const { isStaffAccess } = require("../helpers/staffAccess");
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
  findUserById: ({ userId, shopId, connection }) => queryResult(
    connection,
    `SELECT id, shopid, username, access
     FROM users
     WHERE id = ? AND shopid = ?
     LIMIT 1`,
    [userId, shopId],
  ).then((rows) => rows[0] || null),
  lockOrder: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT * FROM orders
     WHERE id = ? AND shopid = ?
     LIMIT 1 FOR UPDATE`,
    [orderId, shopId],
  ).then((rows) => rows[0] || null),
  updateStatus: ({
    orderId, shopId, operator, nextStatus, finished, preparedBy, connection,
  }) => queryResult(
    connection,
    `UPDATE orders
     SET status = ?, operator = ?, finished = ?,
         prepared_by_user_id = COALESCE(prepared_by_user_id, ?),
         prepared_by_name = COALESCE(prepared_by_name, ?)
     WHERE id = ? AND shopid = ?`,
    [
      nextStatus,
      operator,
      finished,
      preparedBy ? preparedBy.id : null,
      preparedBy ? preparedBy.name : null,
      orderId,
      shopId,
    ],
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
      const shouldAttributePreparation = Number(order.status) === ORDER_STATUSES.PENDING
        && Number(nextStatus) === ORDER_STATUSES.PREPARING;
      const actor = shouldAttributePreparation && typeof repository.findUserById === "function"
        ? await repository.findUserById({
          userId: operator,
          shopId,
          connection,
        })
        : null;
      const preparedBy = actor && isStaffAccess(actor.access)
        ? { id: Number(actor.id), name: actor.username }
        : null;
      const result = await repository.updateStatus({
        orderId,
        shopId,
        operator,
        nextStatus,
        finished: formatDate(now()),
        preparedBy,
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
