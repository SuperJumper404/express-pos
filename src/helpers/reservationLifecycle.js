const DomainError = require("./domainError");

const TRANSITIONS = {
  commit: { reserved: "committed", committed: "committed" },
  release: { reserved: "released", released: "released" },
};

const nextReservationStatus = (currentStatus, action) => {
  const nextStatus = TRANSITIONS[action] && TRANSITIONS[action][currentStatus];
  if (!nextStatus) {
    throw new DomainError(
      409,
      "RESERVATION_TRANSITION_INVALID",
      `Invalid reservation transition from ${currentStatus} using ${action}`,
      { current_status: currentStatus, action },
    );
  }
  return nextStatus;
};

module.exports = {
  nextReservationStatus,
};
