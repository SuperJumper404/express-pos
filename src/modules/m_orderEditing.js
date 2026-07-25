const crypto = require("crypto");
const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");

const EDITABLE_PAYMENT_STATUSES = new Set(["unpaid", "requires_payment"]);
const isOrderEditable = (order = {}) =>
  Number(order.status) === 1
  && EDITABLE_PAYMENT_STATUSES.has(String(order.payment_status));

const queryResult = async (connection, sql, params = []) => {
  const [result] = await (connection || pool).query(sql, params);
  return result;
};

const sqlRepository = {
  findOrder: ({ orderId, shopId, connection }) => queryResult(
    connection,
    "SELECT * FROM orders WHERE id = ? AND shopid = ? LIMIT 1",
    [orderId, shopId],
  ).then((rows) => rows[0] || null),

  findOrderDetails: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT orderdetail.id, orderdetail.orderid, orderdetail.productid,
            orderdetail.qty, orderdetail.price, orderdetail.total
     FROM orderdetail
     JOIN orders ON orders.id = orderdetail.orderid
     WHERE orderdetail.orderid = ? AND orders.shopid = ?
     ORDER BY orderdetail.id`,
    [orderId, shopId],
  ),

  findSnapshots: ({ detailIds, shopId, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT snapshots.*
       FROM orderdetail_customization_snapshots snapshots
       JOIN orderdetail ON orderdetail.id = snapshots.orderdetail_id
       JOIN orders ON orders.id = orderdetail.orderid
       WHERE snapshots.orderdetail_id IN (?) AND orders.shopid = ?
       ORDER BY snapshots.orderdetail_id, snapshots.step_position,
                snapshots.choice_position, snapshots.id`,
      [detailIds, shopId],
    )
  ),

  findLegacyCustomizations: ({ detailIds, shopId, connection }) => (
    detailIds.length === 0 ? Promise.resolve([]) : queryResult(
      connection,
      `SELECT orders_customization.order_details_id,
              orders_customization.product_choice_id,
              product_choice.name,
              product_choice.price
       FROM orders_customization
       JOIN orderdetail ON orderdetail.id = orders_customization.order_details_id
       JOIN orders ON orders.id = orderdetail.orderid
       LEFT JOIN product_choice
         ON product_choice.id = orders_customization.product_choice_id
       WHERE orders_customization.order_details_id IN (?) AND orders.shopid = ?
       ORDER BY orders_customization.order_details_id, orders_customization.id`,
      [detailIds, shopId],
    )
  ),
};

const groupBy = (rows, key) => rows.reduce((groups, row) => {
  const value = row[key];
  if (!groups.has(value)) groups.set(value, []);
  groups.get(value).push(row);
  return groups;
}, new Map());

const valueForRevision = (value) => (value == null ? null : String(value));
const sortedChoiceIds = (item) => (item.selections || [])
  .map((selection) => selection.product_customization_step_choice_id)
  .map(valueForRevision)
  .sort((left, right) => String(left).localeCompare(String(right)));

const buildContentRevision = (order = {}, items = []) => {
  const canonicalContent = {
    order_id: valueForRevision(order.id),
    items: [...items]
      .sort((left, right) => Number(left.orderdetail_id || left.id)
        - Number(right.orderdetail_id || right.id))
      .map((item) => ({
        orderdetail_id: valueForRevision(item.orderdetail_id || item.id),
        product_id: valueForRevision(item.product_id || item.productid),
        quantity: valueForRevision(item.quantity == null ? item.qty : item.quantity),
        product_customization_step_choice_ids: sortedChoiceIds(item),
      })),
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalContent))
    .digest("hex");
};

const snapshotSelection = (snapshot) => ({
  product_customization_step_id: snapshot.product_customization_step_id,
  product_customization_step_choice_id: snapshot.product_customization_step_choice_id,
  step_name: snapshot.step_name,
  step_position: snapshot.step_position,
  choice_type: snapshot.choice_type,
  choice_name: snapshot.choice_name,
  choice_position: snapshot.choice_position,
  unit_extra_price: parseMoney(snapshot.unit_extra_price),
  linked_product_id: snapshot.linked_product_id,
});

const legacySelection = (selection) => ({
  product_customization_step_id: null,
  product_customization_step_choice_id: null,
  product_choice_id: selection.product_choice_id,
  name: selection.name,
  price: parseMoney(selection.price),
});

const buildOrderEditingModule = ({ repository = sqlRepository } = {}) => {
  const getEditableOrder = async ({ orderId, shopId, connection }) => {
    const order = await repository.findOrder({ orderId, shopId, connection });
    if (!order) return null;
    if (!isOrderEditable(order)) {
      throw new DomainError(
        422,
        "ORDER_NOT_EDITABLE",
        "Cette commande ne peut pas etre modifiee.",
      );
    }

    const details = await repository.findOrderDetails({ orderId, shopId, connection });
    const detailIds = details.map((detail) => detail.id);
    const snapshots = await repository.findSnapshots({ detailIds, shopId, connection });
    const snapshotsByDetail = groupBy(snapshots, "orderdetail_id");
    const legacyDetailIds = detailIds.filter((detailId) => !snapshotsByDetail.has(detailId));
    const legacyCustomizations = await repository.findLegacyCustomizations({
      detailIds: legacyDetailIds,
      shopId,
      connection,
    });
    const legacyByDetail = groupBy(legacyCustomizations, "order_details_id");
    const items = details.map((detail) => {
      const historicalCustomizations = snapshotsByDetail.has(detail.id)
        ? snapshotsByDetail.get(detail.id).map(snapshotSelection)
        : (legacyByDetail.get(detail.id) || []).map(legacySelection);
      return {
        orderdetail_id: detail.id,
        product_id: detail.productid,
        quantity: Number(detail.qty),
        unit_price: parseMoney(detail.price),
        total: parseMoney(detail.total),
        selections: historicalCustomizations.map((selection) => ({
          product_customization_step_choice_id:
            selection.product_customization_step_choice_id,
        })),
        historical_customizations: historicalCustomizations,
        requires_reconfiguration: historicalCustomizations.some(
          (selection) => selection.product_customization_step_choice_id == null,
        ),
      };
    });

    return {
      order: { ...order },
      items,
      content_revision: buildContentRevision(order, items),
    };
  };

  return { getEditableOrder };
};

const orderEditingModule = buildOrderEditingModule();

module.exports = {
  buildContentRevision,
  buildOrderEditingModule,
  getEditableOrder: orderEditingModule.getEditableOrder,
  isOrderEditable,
};
