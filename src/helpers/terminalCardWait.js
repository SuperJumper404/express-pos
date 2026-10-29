const CARD_WAIT_TIMEOUT_MS = 12 * 1000;
const STALE_CREATION_TIMEOUT_MS = 30 * 1000;

const cardWaitExpired = (session, now = Date.now()) => {
  // Legacy processing rows are backfilled by the migration. New reservations
  // have no deadline until handoff: creation and Stripe authorization are not
  // card presentation time.
  const started = session.card_wait_started_at;
  const timestamp = started == null ? NaN : new Date(started).getTime();
  return Number.isFinite(timestamp) && now - timestamp >= CARD_WAIT_TIMEOUT_MS;
};

const staleTerminalCreation = (session, now = Date.now()) => {
  const created = new Date(session.created_at).getTime();
  return session.status === 'creating' && session.card_wait_started_at == null
    && Boolean(session.stripe_payment_intent_id) && Number.isFinite(created)
    && now - created >= STALE_CREATION_TIMEOUT_MS;
};

module.exports = { CARD_WAIT_TIMEOUT_MS, STALE_CREATION_TIMEOUT_MS, cardWaitExpired, staleTerminalCreation };
