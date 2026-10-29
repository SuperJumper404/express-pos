const DomainError = require("./domainError");

// Call inside the commercial mutation transaction, after locking its order.
// Terminal creation/finalization also locks orders before their payment rows.
const assertNoActiveTerminalPayment = async ({ connection, shopId, orderId }) => {
  const [pending] = await connection.query(
    `SELECT p.id FROM stripe_terminal_payment_orders a
     JOIN stripe_terminal_payments p ON p.id = a.terminal_payment_id AND p.shopid = a.shopid
     WHERE a.shopid = ? AND a.order_id = ?
       AND p.status IN ('creating','processing') LIMIT 1 FOR UPDATE`,
    [shopId, orderId],
  );
  if (pending.length) throw new DomainError(409, "TERMINAL_PAYMENT_IN_PROGRESS",
    "Terminez ou annulez le paiement TPE en cours avant de modifier cette commande.");
};

const assertTerminalOrderCanBeDiscarded = (order) => {
  if (order.stripe_terminal_payment_id != null) {
    throw new DomainError(409, "TERMINAL_PAYMENT_REFUND_REQUIRED",
      "Cette commande a ete encaissee par TPE. Utilisez le parcours de remboursement et conservez son historique.");
  }
};

module.exports = { assertNoActiveTerminalPayment, assertTerminalOrderCanBeDiscarded };
