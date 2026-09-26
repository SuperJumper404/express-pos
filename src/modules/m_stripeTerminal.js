const queryWith = async (connection, sql, params = []) => {
  if (typeof connection.promise === "function") {
    return new Promise((resolve, reject) => {
      connection.query(sql, params, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }
  const [result] = await connection.query(sql, params);
  return result;
};

const requireShopId = (shopId) => {
  if (!Number.isSafeInteger(Number(shopId)) || Number(shopId) <= 0) {
    throw new Error("shopId is required");
  }
};

const first = (rows) => rows[0] || null;

const buildStripeTerminalModule = ({ connection }) => {
  if (!connection || typeof connection.query !== "function") {
    throw new Error("A database connection is required");
  }
  const query = (sql, params) => queryWith(connection, sql, params);

  // A nonblocking, connection-owned lock elects one creator across processes.
  // Use this same connection for all work so lock holders cannot exhaust the pool.
  const withPaymentCreationLock = async ({ shopId, paymentId }, work) => {
    requireShopId(shopId);
    if (!Number.isSafeInteger(paymentId) || paymentId <= 0) throw new Error("paymentId is required");
    const dedicated = await connection.getConnection();
    const lockName = `pos:terminal-payment:${Number(shopId)}:${paymentId}`;
    let acquired = false;
    let reusable = false;
    let rollbackFailed = false;
    try {
      const rows = await queryWith(dedicated, "SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
      acquired = rows[0].acquired === 1;
      if (!acquired) {
        reusable = rows[0].acquired === 0;
        if (reusable) return null;
        throw new Error("Terminal payment lock unavailable");
      }
      const store = buildStripeTerminalModule({ connection: dedicated });
      store.withTransaction = async (transactionWork) => {
        try {
          await dedicated.beginTransaction();
          const result = await transactionWork(store);
          await dedicated.commit();
          return result;
        } catch (error) {
          try { await dedicated.rollback(); }
          catch (rollbackError) {
            rollbackFailed = true;
            throw new Error("Terminal transaction rollback failed");
          }
          throw error;
        }
      };
      return await work(store);
    } finally {
      if (acquired) {
        try {
          const rows = await queryWith(dedicated, "SELECT RELEASE_LOCK(?) AS released", [lockName]);
          reusable = rows[0].released === 1 && !rollbackFailed;
        } catch (error) { reusable = false; }
      }
      if (reusable) dedicated.release();
      else dedicated.destroy();
    }
  };

  // A shop lock also serializes first-location creation across application instances.
  // Locked work never needs a second checkout from a pool occupied by waiters.
  const withRegistrationLock = async ({ shopId }, work) => {
    requireShopId(shopId);
    const dedicated = await connection.getConnection();
    const lockName = `pos:terminal-registration:${Number(shopId)}`;
    let acquired = false;
    let reusable = false;
    try {
      const rows = await queryWith(dedicated, "SELECT GET_LOCK(?, 10) AS acquired", [lockName]);
      acquired = rows[0].acquired === 1;
      if (!acquired) {
        reusable = rows[0].acquired === 0;
        const error = new Error("Terminal registration is busy");
        error.code = "TERMINAL_REGISTRATION_BUSY";
        throw error;
      }
      return await work({
        terminalStore: buildStripeTerminalModule({ connection: dedicated }),
        staffStore: {
          findUserByIdAndShop: async ({ id, shopId: userShopId }) => first(await queryWith(
            dedicated,
            "SELECT id, shopid, access, status FROM users WHERE id = ? AND shopid = ? LIMIT 1",
            [id, userShopId],
          )),
        },
      });
    } finally {
      if (acquired) {
        try {
          const rows = await queryWith(dedicated, "SELECT RELEASE_LOCK(?) AS released", [lockName]);
          reusable = rows[0].released === 1;
        } catch (error) {
          reusable = false;
        }
      }
      // A connection with an uncertain lock must never return to the pool.
      if (reusable) dedicated.release();
      else dedicated.destroy();
    }
  };

  const findLocation = async ({ shopId }) => {
    requireShopId(shopId);
    return first(await query(
      "SELECT * FROM stripe_terminal_locations WHERE shopid = ? LIMIT 1",
      [shopId],
    ));
  };

  const createLocation = async ({ shopId, stripeLocationId, displayName, address }) => {
    requireShopId(shopId);
    return query("INSERT INTO stripe_terminal_locations SET ?", [{
      shopid: shopId,
      stripe_location_id: stripeLocationId,
      display_name: displayName,
      address_line1: address.line1,
      postal_code: address.postalCode,
      city: address.city,
      country: address.country || "FR",
    }]);
  };

  const updateLocation = async ({ shopId, stripeLocationId, displayName, address }) => {
    requireShopId(shopId);
    return query(
      `UPDATE stripe_terminal_locations SET stripe_location_id = ?, display_name = ?,
         address_line1 = ?, postal_code = ?, city = ?, country = ?
       WHERE shopid = ?`,
      [stripeLocationId, displayName, address.line1, address.postalCode,
        address.city, address.country || "FR", shopId],
    );
  };

  const listReaders = ({ shopId }) => {
    requireShopId(shopId);
    return query(
      `SELECT r.* FROM stripe_terminal_readers r
       WHERE r.shopid = ? ORDER BY r.id`,
      [shopId],
    );
  };

  const findReader = async ({ shopId, readerId, forUpdate = false }) => {
    requireShopId(shopId);
    return first(await query(
      `SELECT r.* FROM stripe_terminal_readers r
       WHERE r.shopid = ? AND r.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [shopId, readerId],
    ));
  };

  const findAssignedReader = async ({ shopId, userId, forUpdate = false }) => {
    requireShopId(shopId);
    return first(await query(
      `SELECT r.* FROM stripe_terminal_readers r
       JOIN users u ON u.id = r.assigned_user_id AND u.shopid = r.shopid
       WHERE r.shopid = ? AND r.assigned_user_id = ?
         AND r.is_active = 1 AND u.status = 1
       LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [shopId, userId],
    ));
  };

  const createReader = ({ shopId, locationId, stripeReaderId, serialNumber,
    deviceType, label, status, assignedUserId = null, assignedServicePointId = null }) => {
    requireShopId(shopId);
    return query(
      `INSERT INTO stripe_terminal_readers
         (shopid, terminal_location_id, stripe_reader_id, serial_number,
          device_type, label, status, assigned_user_id, assigned_service_point_id)
       SELECT l.shopid, l.id, ?, ?, ?, ?, ?, ?, ?
       FROM stripe_terminal_locations l
       WHERE l.shopid = ? AND l.id = ?`,
      [stripeReaderId, serialNumber || null, deviceType || null, label, status || "offline",
        assignedUserId, assignedServicePointId, shopId, locationId],
    );
  };

  const updateReader = ({ shopId, readerId, label, status,
    assignedUserId, assignedServicePointId, isActive }) => {
    requireShopId(shopId);
    const updates = [];
    const params = [];
    for (const [value, column] of [
      [label, "label"], [status, "status"], [assignedUserId, "assigned_user_id"],
      [assignedServicePointId, "assigned_service_point_id"], [isActive, "is_active"],
    ]) {
      if (value !== undefined) {
        updates.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (!updates.length) throw new Error("No reader fields to update");
    return query(
      `UPDATE stripe_terminal_readers SET ${updates.join(", ")}
       WHERE shopid = ? AND id = ?`,
      [...params, shopId, readerId],
    );
  };

  const findActivePaymentForReader = async ({ shopId, readerId, forUpdate = false }) => {
    requireShopId(shopId);
    return first(await query(
      `SELECT p.* FROM stripe_terminal_payments p
       WHERE p.shopid = ? AND p.terminal_reader_id = ?
         AND p.status IN ('creating', 'processing')
       LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [shopId, readerId],
    ));
  };

  const createPaymentSession = async ({ shopId, readerId, cashierUserId, idempotencyKey,
    amountCents, applicationFeeAmount, currency = "eur", discountType = null,
    discountValue = null }) => {
    requireShopId(shopId);
    const result = await query(
      `INSERT INTO stripe_terminal_payments
         (shopid, terminal_reader_id, cashier_user_id, idempotency_key,
          amount_cents, application_fee_amount, currency, discount_type,
          discount_value, status)
       SELECT r.shopid, r.id, u.id, ?, ?, ?, ?, ?, ?, 'creating'
       FROM stripe_terminal_readers r
       JOIN users u ON u.id = r.assigned_user_id AND u.shopid = r.shopid
       WHERE r.shopid = ? AND r.id = ? AND r.assigned_user_id = ?
         AND r.is_active = 1 AND u.status = 1`,
      [idempotencyKey, amountCents, applicationFeeAmount, currency,
        discountType, discountValue, shopId, readerId, cashierUserId],
    );
    if (result.affectedRows !== 1) throw new Error("Invalid Terminal reader assignment");
    return result;
  };

  const findPaymentSession = async ({ shopId, paymentId, forUpdate = false }) => {
    requireShopId(shopId);
    return first(await query(
      `SELECT p.* FROM stripe_terminal_payments p
       WHERE p.shopid = ? AND p.id = ? LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [shopId, paymentId],
    ));
  };

  const findPaymentByIntent = async ({ shopId, stripePaymentIntentId, forUpdate = false }) => {
    requireShopId(shopId);
    return first(await query(
      `SELECT p.* FROM stripe_terminal_payments p
       WHERE p.shopid = ? AND p.stripe_payment_intent_id = ?
       LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [shopId, stripePaymentIntentId],
    ));
  };

  const findPaymentByIdempotencyKey = async ({ shopId, idempotencyKey }) => {
    requireShopId(shopId);
    return first(await query(
      `SELECT p.* FROM stripe_terminal_payments p
       WHERE p.shopid = ? AND p.idempotency_key = ? LIMIT 1`,
      [shopId, idempotencyKey],
    ));
  };

  const updatePaymentSession = ({ shopId, paymentId, stripePaymentIntentId,
    stripeChargeId, status, failureCode, failureMessage }) => {
    requireShopId(shopId);
    if (status === "succeeded") {
      throw new Error("Use finalizePaymentSucceeded for successful payments");
    }
    const updates = [];
    const params = [];
    for (const [value, column] of [
      [stripePaymentIntentId, "stripe_payment_intent_id"],
      [stripeChargeId, "stripe_charge_id"], [status, "status"],
      [failureCode, "failure_code"], [failureMessage, "failure_message"],
    ]) {
      if (value !== undefined) {
        updates.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (!updates.length) throw new Error("No payment fields to update");
    return query(
      `UPDATE stripe_terminal_payments SET ${updates.join(", ")}
       WHERE shopid = ? AND id = ? AND status <> 'succeeded'`,
      [...params, shopId, paymentId],
    );
  };

  const createAllocations = async ({ shopId, paymentId, allocations }) => {
    requireShopId(shopId);
    if (!Array.isArray(allocations) || allocations.length === 0) {
      throw new Error("Terminal allocations are required");
    }
    for (const { orderId, amountCents } of allocations) {
      const result = await query(
        `INSERT INTO stripe_terminal_payment_orders
           (terminal_payment_id, order_id, amount_cents, shopid)
         SELECT p.id, o.id, ?, p.shopid
         FROM stripe_terminal_payments p
         JOIN orders o ON o.id = ? AND o.shopid = p.shopid
         WHERE p.id = ? AND p.shopid = ?`,
        [amountCents, orderId, paymentId, shopId],
      );
      if (result.affectedRows !== 1) throw new Error("Invalid Terminal allocation");
    }
  };

  const listPaymentAllocations = ({ shopId, paymentId }) => {
    requireShopId(shopId);
    return query(
      `SELECT a.* FROM stripe_terminal_payment_orders a
       JOIN stripe_terminal_payments p ON p.id = a.terminal_payment_id
         AND p.shopid = a.shopid
       WHERE a.shopid = ? AND a.terminal_payment_id = ? AND p.shopid = ?
       ORDER BY a.order_id`,
      [shopId, paymentId, shopId],
    );
  };

  const findOrderAllocation = async ({ shopId, orderId, paymentId }) => {
    requireShopId(shopId);
    if (!Number.isSafeInteger(Number(paymentId)) || Number(paymentId) <= 0) {
      throw new Error("paymentId is required");
    }
    return first(await query(
      `SELECT a.* FROM stripe_terminal_payment_orders a
       JOIN stripe_terminal_payments p ON p.id = a.terminal_payment_id
         AND p.shopid = a.shopid
       WHERE a.shopid = ? AND a.order_id = ?
         AND a.terminal_payment_id = ? AND p.shopid = ?
         AND p.status = 'succeeded' LIMIT 1`,
      [shopId, orderId, paymentId, shopId],
    ));
  };

  // The caller holds one transaction connection for all three locking reads.
  const lockReaderAndOrders = async ({ shopId, userId, orderIds }) => {
    requireShopId(shopId);
    if (!Array.isArray(orderIds) || !orderIds.length
      || orderIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(orderIds).size !== orderIds.length) {
      throw new Error("Invalid Terminal order selection");
    }
    const reader = await findAssignedReader({ shopId, userId, forUpdate: true });
    if (!reader) throw new Error("No active assigned Terminal reader");
    const sortedIds = [...orderIds].sort((a, b) => a - b);
    const orders = await query(
      `SELECT o.* FROM orders o
       WHERE o.shopid = ? AND o.id IN (${sortedIds.map(() => "?").join(", ")})
       ORDER BY o.id FOR UPDATE`,
      [shopId, ...sortedIds],
    );
    if (orders.length !== sortedIds.length || orders.some((order, index) => (
      order.id !== sortedIds[index]
      || Number(order.shopid) !== Number(shopId)
      || Number(order.status) !== 1
      || order.payment_status !== "unpaid"
      || order.stripe_terminal_payment_id != null
    ))) throw new Error("Invalid Terminal order selection");
    const activePayment = await findActivePaymentForReader({
      shopId, readerId: reader.id, forUpdate: true,
    });
    const competingPayment = await query(
      `SELECT a.order_id FROM stripe_terminal_payment_orders a
       JOIN stripe_terminal_payments p ON p.id = a.terminal_payment_id
         AND p.shopid = a.shopid
       WHERE a.shopid = ? AND p.shopid = ?
         AND a.order_id IN (${sortedIds.map(() => "?").join(", ")})
         AND p.status IN ('creating', 'processing')
         AND p.terminal_reader_id <> ?
       LIMIT 1 FOR UPDATE`,
      [shopId, shopId, ...sortedIds, reader.id],
    );
    if (competingPayment.length) throw new Error("Order has an active Terminal payment");
    return { reader, orders, activePayment };
  };

  // Allocations are immutable after reservation. Lock their orders in the same
  // order as start, then read the current payment (never payment -> orders).
  const lockPaymentSession = async ({ shopId, paymentId }) => {
    requireShopId(shopId);
    const allocations = await listPaymentAllocations({ shopId, paymentId });
    const orderIds = allocations.map((allocation) => allocation.order_id).sort((a, b) => a - b);
    const orders = orderIds.length ? await query(
      `SELECT o.* FROM orders o
       WHERE o.shopid = ? AND o.id IN (${orderIds.map(() => "?").join(", ")})
       ORDER BY o.id FOR UPDATE`,
      [shopId, ...orderIds],
    ) : [];
    const payment = await findPaymentSession({ shopId, paymentId, forUpdate: true });
    return { payment, orders, allocations };
  };

  // The caller rolls back its transaction if any allocation or order update fails.
  const finalizePaymentSucceeded = async ({ shopId, paymentId,
    stripePaymentIntentId, stripeChargeId = null, timestamp }) => {
    requireShopId(shopId);
    const { payment, orders: lockedOrders, allocations } = await lockPaymentSession({ shopId, paymentId });
    if (!payment) throw new Error("Terminal payment not found");
    if (!stripePaymentIntentId || payment.stripe_payment_intent_id !== stripePaymentIntentId) {
      throw new Error("Terminal payment cannot be finalized");
    }
    if (payment.status === "succeeded") return { finalized: false };
    const count = allocations.length;
    if (!count) throw new Error("Terminal payment has no allocations");
    if (lockedOrders.length !== count || lockedOrders.some((order) => (
      Number(order.shopid) !== Number(shopId) || Number(order.status) !== 1
      || order.payment_status !== "unpaid" || order.stripe_terminal_payment_id != null
    ))) throw new Error("Terminal order finalization incomplete");
    const orders = await query(
      `UPDATE orders o
       JOIN stripe_terminal_payment_orders a ON a.order_id = o.id
         AND a.shopid = o.shopid
       SET o.payment_status = 'paid',
           o.payment_provider = 'stripe_terminal',
           o.payment = 'Carte bancaire - TPE Stripe',
           o.stripe_terminal_payment_id = ?,
           o.finished = ?
       WHERE o.shopid = ? AND a.shopid = ? AND a.terminal_payment_id = ?
         AND o.payment_status = 'unpaid' AND o.stripe_terminal_payment_id IS NULL`,
      [paymentId, timestamp, shopId, shopId, paymentId],
    );
    if (orders.affectedRows !== count) throw new Error("Terminal order finalization incomplete");
    const result = await query(
      `UPDATE stripe_terminal_payments
       SET status = 'succeeded', stripe_charge_id = ?
       WHERE stripe_terminal_payments.shopid = ? AND id = ?
         AND stripe_payment_intent_id = ? AND status <> 'succeeded'`,
      [stripeChargeId, shopId, paymentId, stripePaymentIntentId],
    );
    if (result.affectedRows !== 1) throw new Error("Terminal payment finalization incomplete");
    return { finalized: true };
  };

  return {
    withRegistrationLock, withPaymentCreationLock,
    findLocation, createLocation, updateLocation,
    listReaders, findReader, findAssignedReader, createReader, updateReader,
    findActivePaymentForReader, createPaymentSession, findPaymentSession,
    findPaymentByIntent, findPaymentByIdempotencyKey, updatePaymentSession,
    createAllocations, listPaymentAllocations, findOrderAllocation,
    lockReaderAndOrders, lockPaymentSession, finalizePaymentSucceeded,
  };
};

module.exports = { buildStripeTerminalModule };
