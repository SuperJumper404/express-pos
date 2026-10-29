const { buildTerminalCardTicket } = require('./stripeTerminalCardTicket');

const standalonePaymentDto = (session, intent = null) => ({
  id: Number(session.id),
  paymentKind: 'standalone',
  readerId: Number(session.terminal_reader_id),
  readerLabel: session.reader_label || null,
  status: session.status,
  amountCents: Number(session.amount_cents),
  currency: session.currency,
  createdAt: new Date(session.created_at).toISOString(),
  confirmedAt: session.confirmed_at ? new Date(session.confirmed_at).toISOString() : null,
  failureCode: session.failure_code === 'TERMINAL_PAYMENT_FAILED' ? session.failure_code : null,
  failureMessage: session.failure_code === 'TERMINAL_PAYMENT_FAILED' ? 'Le paiement sur le terminal a echoue.' : null,
  cardTicket: session.status === 'succeeded' ? buildTerminalCardTicket(session, intent) : null,
  attachmentsCount: Number(session.attachments_count || 0),
});

module.exports = { standalonePaymentDto };
