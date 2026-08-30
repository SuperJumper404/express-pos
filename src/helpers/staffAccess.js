const STAFF_ACCESS_VALUES = new Set([0, 1, 4, 5]);
const ORDER_TAKER_ACCESS_VALUES = new Set([0, 1, 4]);

const isStaffAccess = (access) => STAFF_ACCESS_VALUES.has(Number(access));
const isOrderTakerAccess = (access) => ORDER_TAKER_ACCESS_VALUES.has(Number(access));

module.exports = { isOrderTakerAccess, isStaffAccess };
