const { custom, failed } = require("../helpers/response");
const { parseModulePermissions } = require("../helpers/staffPermissions");
const { buildTerminalPaymentHistoryModule, TerminalPaymentHistoryError } = require("../modules/m_terminalPaymentHistory");

let defaultHistoryStore;
const getDefaultHistoryStore = () => {
  if (!defaultHistoryStore) defaultHistoryStore = buildTerminalPaymentHistoryModule({ connection: require("../config/dbPool") });
  return defaultHistoryStore;
};
const canReadHistory = req => {
  if (req.sessionSubject !== "staff" || ![0, 1, 4, 5].includes(req.access)) return false;
  if (req.access === 0) return true;
  const user = req.currentUser;
  if (!user || Number(user.id) !== Number(req.id) || Number(user.shopid) !== Number(req.shopid)
    || Number(user.status) !== 1 || Number(user.access) !== req.access) return false;
  const permissions = parseModulePermissions(user.module_permissions, user.access);
  return Array.isArray(permissions) && permissions.includes("history");
};
const queryParameters = req => {
  const query = req.query || {};
  return { search: query.search, page: query.page, itemsPerPage: query.itemsPerPage, sortBy: query.sortBy, sortDesc: query.sortDesc };
};
const buildTerminalPaymentHistoryController = ({ historyStore } = {}) => {
  const handle = (method, parameters) => async (req, res) => {
    if (!canReadHistory(req)) return failed(res, "Acces a l'historique refuse.", "TERMINAL_FORBIDDEN", 403);
    try {
      const data = await (historyStore || getDefaultHistoryStore())[method]({ ...parameters(req), shopId: req.shopid, userId: req.id });
      return custom(res, 200, "Historique terminal recupere.", null, data);
    } catch (error) {
      const safeError = error instanceof TerminalPaymentHistoryError ? error : new TerminalPaymentHistoryError("TERMINAL_INTERNAL_ERROR");
      return failed(res, safeError.message, safeError.code, safeError.statusCode);
    }
  };
  return {
    listEntries: handle("listEntries", queryParameters),
    listAttachmentCandidates: handle("listAttachmentCandidates", req => ({ ...queryParameters(req), includeActive: (req.query || {}).includeActive })),
    getAttachments: handle("getAttachments", req => ({ paymentId: req.params.id })),
    addAttachments: handle("addAttachments", req => ({ paymentId: req.params.id, archiveIds: (req.body || {}).archiveIds, orderIds: (req.body || {}).orderIds })),
    removeOrderAttachment: handle("removeAttachment", req => ({ paymentId: req.params.id, orderId: req.params.orderId })),
    removeAttachment: handle("removeAttachment", req => ({ paymentId: req.params.id, archiveId: req.params.archiveId })),
  };
};

module.exports = { buildTerminalPaymentHistoryController, ...buildTerminalPaymentHistoryController() };
