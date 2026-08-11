const ACCESS = {
  ADMIN: 0,
  CASHIER: 1,
  TABLE_QR: 2,
  CLICK_AND_COLLECT: 3,
  SERVER: 4,
  KITCHEN: 5,
};

const STAFF_MODULE_KEYS = [
  "home",
  "orders",
  "cashregister",
  "history",
  "catalog",
  "stocks",
  "tables",
  "reports",
  "website",
];

const DEFAULT_MODULES_BY_ACCESS = {
  [ACCESS.ADMIN]: STAFF_MODULE_KEYS,
  [ACCESS.CASHIER]: ["orders", "cashregister", "history"],
  [ACCESS.SERVER]: ["orders"],
  [ACCESS.KITCHEN]: ["orders"],
};

const getDefaultModulePermissions = (access) => [
  ...(DEFAULT_MODULES_BY_ACCESS[Number(access)] || []),
];

const normalizeModulePermissions = (value, access) => {
  const source = Array.isArray(value)
    ? value
    : getDefaultModulePermissions(access);
  return [...new Set(source.filter((key) => STAFF_MODULE_KEYS.includes(key)))];
};

module.exports = {
  ACCESS,
  STAFF_MODULE_KEYS,
  getDefaultModulePermissions,
  normalizeModulePermissions,
};
