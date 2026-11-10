// Attachments are informational and may share orders: never join them into money totals.
const mGetStandaloneReportPayments = async ({ shopId, from, to, unclosed = false, closedAt, connection = require('../config/dbPool') }) => {
  const clauses = ["p.shopid = ?", "p.payment_kind = 'standalone'", "p.status = 'succeeded'"];
  const values = [shopId];
  const eventAt = 'COALESCE(p.confirmed_at, p.created_at)';
  if (from) { clauses.push(`${eventAt} >= ?`); values.push(from); }
  if (to) { clauses.push(`${eventAt} < DATE_ADD(?, INTERVAL 1 DAY)`); values.push(to); }
  if (unclosed) clauses.push('p.cash_closure_id IS NULL');
  if (closedAt) { clauses.push(`${eventAt} <= ?`); values.push(closedAt); }
  const [rows] = await connection.query(`SELECT p.id, p.amount_cents,
    DATE_FORMAT(${eventAt}, '%Y-%m-%d %H:%i:%s.%f') AS confirmed_at
    FROM stripe_terminal_payments p WHERE ${clauses.join(' AND ')} ORDER BY ${eventAt}, p.id`, values);
  return rows;
};

const uniqueStandalonePayments = payments => [...new Map((payments || []).map(row => [String(row.id), row])).values()];
const standalonePaymentSummary = payments => {
  const rows = uniqueStandalonePayments(payments);
  return { count: rows.length, total: rows.reduce((sum, row) => sum + Number(row.amount_cents), 0) / 100 };
};
const standaloneReportEntries = payments => uniqueStandalonePayments(payments).map(row => ({
  subtotal: Number(row.amount_cents) / 100, payment: 'TPE Stripe', payment_provider: 'stripe_terminal',
  created: row.confirmed_at, archived_at: row.confirmed_at,
}));

module.exports = { mGetStandaloneReportPayments, standalonePaymentSummary, standaloneReportEntries };
