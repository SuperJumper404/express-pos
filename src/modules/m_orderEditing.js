const crypto = require("crypto");
const pool = require("../config/dbPool");
const DomainError = require("../helpers/domainError");
const { parseMoney } = require("../helpers/money");
const {
  getResolvedProductConfigurations,
} = require("./m_customizations");

const EDITABLE_PAYMENT_STATUSES = new Set(["unpaid", "requires_payment"]);
const isEditableOrder = (order = {}) => (
  Number(order.status) === 1
  && EDITABLE_PAYMENT_STATUSES.has(String(order.payment_status))
);

const canonicalContent = ({ order, details, snapshots }) => ({
  subtotal: parseMoney(order.subtotal),
  items: [...details]
    .sort((left, right) => Number(left.id) - Number(right.id))
    .map((detail) => ({
      product_id: Number(detail.productid),
      quantity: Number(detail.qty),
      unit_price: parseMoney(detail.price),
      total: parseMoney(detail.total),
      choices: snapshots
        .filter((row) => Number(row.orderdetail_id) === Number(detail.id))
        .sort((left, right) => (
          Number(left.step_position) - Number(right.step_position)
          || Number(left.choice_position) - Number(right.choice_position)
          || Number(left.id || 0) - Number(right.id || 0)
        ))
        .map((row) => ({
          contextual_id: row.product_customization_step_choice_id == null
            ? null
            : Number(row.product_customization_step_choice_id),
          step_name: row.step_name,
          choice_name: row.choice_name,
          extra_price: parseMoney(row.unit_extra_price),
          linked_product_id: row.linked_product_id == null
            ? null
            : Number(row.linked_product_id),
        })),
    })),
});

const buildContentRevision = (content) => crypto
  .createHash("sha256")
  .update(JSON.stringify(canonicalContent(content)))
  .digest("hex");

const notEditable = (order) => new DomainError(
  409,
  "ORDER_NOT_EDITABLE",
  "Cette commande ne peut plus être modifiée.",
  {
    order_status: order && order.status,
    payment_status: order && order.payment_status,
  },
);

const queryResult = async (connection, sql, params = []) => {
  const [result] = await (connection || pool).query(sql, params);
  return result;
};

const sqlRepository = {
  findOrder: ({ orderId, shopId, connection }) => queryResult(
    connection,
    `SELECT * FROM orders
     WHERE id = ? AND shopid = ?
     LIMIT 1`,
    [orderId, shopId],
  ).then((rows) => rows[0] || null),
  findDetails: ({ orderId, connection }) => queryResult(
    connection,
    `SELECT orderdetail.*, products.name, products.image
     FROM orderdetail
     JOIN products ON products.id = orderdetail.productid
     WHERE orderdetail.orderid = ?
     ORDER BY orderdetail.id`,
    [orderId],
  ),
  findSnapshots: ({ detailIds, connection }) => (
    detailIds.length === 0
      ? Promise.resolve([])
      : queryResult(
        connection,
        `SELECT * FROM orderdetail_customization_snapshots
         WHERE orderdetail_id IN (?)
         ORDER BY orderdetail_id, step_position, choice_position, id`,
        [detailIds],
      )
  ),
};

const disabled = (value) => [false, 0, "0"].includes(value);
const configurationFor = (configurations, productId) => (
  configurations.get(Number(productId))
  || configurations.get(String(productId))
  || []
);

const snapshotRequiresReconfiguration = (snapshot, steps) => {
  const contextualId = snapshot.product_customization_step_choice_id;
  if (contextualId == null) return true;

  for (const step of steps) {
    const choice = (step.choices || []).find(
      (candidate) => Number(candidate.product_step_choice_id) === Number(contextualId),
    );
    if (!choice) continue;
    return disabled(step.active)
      || disabled(step.available)
      || disabled(choice.active)
      || disabled(choice.available);
  }
  return true;
};

const mapSnapshot = (snapshot) => ({
  product_customization_step_id: snapshot.product_customization_step_id == null
    ? null
    : Number(snapshot.product_customization_step_id),
  product_customization_step_choice_id:
    snapshot.product_customization_step_choice_id == null
      ? null
      : Number(snapshot.product_customization_step_choice_id),
  step_name: snapshot.step_name,
  step_position: Number(snapshot.step_position),
  choice_type: snapshot.choice_type,
  choice_name: snapshot.choice_name,
  choice_position: Number(snapshot.choice_position),
  unit_extra_price: parseMoney(snapshot.unit_extra_price),
  linked_product_id: snapshot.linked_product_id == null
    ? null
    : Number(snapshot.linked_product_id),
});

const buildOrderEditingModule = ({
  repository = sqlRepository,
  getResolvedProductConfigurations: loadConfigurations = (
    getResolvedProductConfigurations
  ),
} = {}) => {
  const getEditableOrder = async ({ orderId, shopId, connection }) => {
    const order = await repository.findOrder({ orderId, shopId, connection });
    if (!order) {
      throw new DomainError(404, "ORDER_NOT_FOUND", "Commande introuvable.");
    }
    if (!isEditableOrder(order)) throw notEditable(order);

    const details = await repository.findDetails({ orderId: order.id, connection });
    const detailIds = details.map((detail) => Number(detail.id));
    const snapshots = await repository.findSnapshots({ detailIds, connection });
    const productIds = [...new Set(details.map((detail) => Number(detail.productid)))]
      .sort((left, right) => left - right);
    const configurations = productIds.length
      ? await loadConfigurations({ shopId, productIds, connection })
      : new Map();

    const items = details.map((detail) => {
      const itemSnapshots = snapshots.filter(
        (snapshot) => Number(snapshot.orderdetail_id) === Number(detail.id),
      );
      const steps = configurationFor(configurations, detail.productid);
      return {
        order_detail_id: Number(detail.id),
        product_id: Number(detail.productid),
        name: detail.name,
        image: detail.image,
        quantity: Number(detail.qty),
        unit_price: parseMoney(detail.price),
        line_total: parseMoney(detail.total),
        selected_product_step_choice_ids: itemSnapshots
          .map((snapshot) => snapshot.product_customization_step_choice_id)
          .filter((id) => id != null)
          .map(Number),
        customization_snapshots: itemSnapshots.map(mapSnapshot),
        requires_reconfiguration: itemSnapshots.some(
          (snapshot) => snapshotRequiresReconfiguration(snapshot, steps),
        ),
      };
    });

    return {
      order_id: Number(order.id),
      order_number: order.ordernumber,
      status: Number(order.status),
      payment_status: order.payment_status,
      payment_provider: order.payment_provider,
      total: parseMoney(order.subtotal),
      content_revision: buildContentRevision({ order, details, snapshots }),
      items,
    };
  };

  return { getEditableOrder };
};

const orderEditingModule = buildOrderEditingModule();

module.exports = {
  buildContentRevision,
  buildOrderEditingModule,
  getEditableOrder: orderEditingModule.getEditableOrder,
  isEditableOrder,
  notEditable,
};
