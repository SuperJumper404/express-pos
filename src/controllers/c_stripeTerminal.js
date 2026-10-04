const { custom, failed } = require("../helpers/response");
const { isStaffAccess } = require("../helpers/staffAccess");
const { buildStripeTerminalModule } = require("../modules/m_stripeTerminal");
const { buildStripeTerminalReaderService, TerminalReaderError } = require("../services/stripeTerminalReaders");
const { buildStripeTerminalPaymentService, TerminalPaymentError } = require("../services/stripeTerminalPayments");
const { buildStripeTerminalKioskPaymentService } = require("../services/stripeTerminalKioskPayments");

let defaultPaymentService;
const getDefaultPaymentService = () => {
  if (!defaultPaymentService) {
    const connection = require("../config/dbPool");
    const { withTransaction } = require("../helpers/withTransaction");
    const { getStripe } = require("../config/stripe");
    defaultPaymentService = buildStripeTerminalPaymentService({
      stripe: {
        get terminal() { return getStripe().terminal; },
        get paymentIntents() { return getStripe().paymentIntents; },
      },
      terminalStore: {
        ...buildStripeTerminalModule({ connection }),
        withTransaction: (work) => withTransaction((transaction) => work(
          buildStripeTerminalModule({ connection: transaction }),
        )),
      },
      shopStore: {
        findShop: async ({ shopId }) => {
          const [rows] = await connection.query(
            "SELECT id, stripe_account_id, stripe_charges_enabled, stripe_commission_percent FROM shop WHERE id = ? LIMIT 1",
            [shopId],
          );
          return rows[0] || null;
        },
      },
    });
  }
  return defaultPaymentService;
};

let defaultReaderService;
const getDefaultReaderService = () => {
  if (!defaultReaderService) {
    const connection = require("../config/dbPool");
    const { getStripe } = require("../config/stripe");
    defaultReaderService = buildStripeTerminalReaderService({
      stripe: { get terminal() { return getStripe().terminal; } },
      terminalStore: buildStripeTerminalModule({ connection }),
      staffStore: {
        findUserByIdAndShop: async ({ id, shopId }) => {
          const [rows] = await connection.query(
            "SELECT id, shopid, access, status FROM users WHERE id = ? AND shopid = ? LIMIT 1",
            [id, shopId],
          );
          return rows[0] || null;
        },
        findServicePointByIdAndShop: async ({ id, shopId }) => {
          const [rows] = await connection.query(
            "SELECT id, shopid, type, is_active FROM service_points WHERE id = ? AND shopid = ? LIMIT 1",
            [id, shopId],
          );
          return rows[0] || null;
        },
      },
    });
  }
  return defaultReaderService;
};

let defaultKioskPaymentService;
const getDefaultKioskPaymentService = () => {
  if (!defaultKioskPaymentService) {
    const connection = require("../config/dbPool");
    const { withTransaction } = require("../helpers/withTransaction");
    const { getStripe } = require("../config/stripe");
    const checkout = require("../modules/m_checkout");
    defaultKioskPaymentService = buildStripeTerminalKioskPaymentService({
      stripe: {
        get terminal() { return getStripe().terminal; },
        get paymentIntents() { return getStripe().paymentIntents; },
      },
      terminalStore: {
        ...buildStripeTerminalModule({ connection }),
        withTransaction: (work) => withTransaction((transaction) => work(
          buildStripeTerminalModule({ connection: transaction }),
        )),
      },
      checkout,
      shopStore: {
        findShop: async ({ shopId }) => {
          const [rows] = await connection.query(
            "SELECT id, stripe_account_id, stripe_charges_enabled, stripe_commission_percent FROM shop WHERE id = ? LIMIT 1",
            [shopId],
          );
          return rows[0] || null;
        },
      },
    });
  }
  return defaultKioskPaymentService;
};

const pickCheckoutPayload = (body = {}) => {
  const allowed = [
    "customer", "customerID", "phone", "remark", "items", "expected_total",
    "discount_type", "discount_value", "is_takeaway", "client_order_token",
  ];
  return allowed.reduce((result, key) => {
    if (body[key] !== undefined) result[key] = body[key];
    return result;
  }, {});
};

const buildStripeTerminalController = ({ readerService, paymentService, kioskPaymentService } = {}) => {
  const handle = (method, parameters, { admin = true, status = 200, payment = false } = {}) => async (req, res) => {
    if (req.sessionSubject === "service_point" || req.access == null
      || !isStaffAccess(req.access) || (admin && req.access !== 0)) {
      return failed(res, "Acces au terminal refuse.", "TERMINAL_FORBIDDEN", 403);
    }
    try {
      const service = payment ? paymentService || getDefaultPaymentService() : readerService || getDefaultReaderService();
      const data = await service[method]({
        ...parameters(req), shopId: req.shopid, ...(payment ? { cashierUserId: req.id } : { actorUserId: req.id }),
      });
      return custom(res, status, "Terminal mis a jour.", null, data);
    } catch (error) {
      const safeError = error instanceof TerminalReaderError || error instanceof TerminalPaymentError
        ? error : new (payment ? TerminalPaymentError : TerminalReaderError)("TERMINAL_INTERNAL_ERROR");
      return failed(res, safeError.message, safeError.code, safeError.statusCode);
    }
  };
  const kioskHandle = (method, parameters, { status = 200 } = {}) => async (req, res) => {
    if (req.sessionSubject !== "service_point" || req.shopid == null || req.servicePointId == null) {
      return failed(res, "Acces au terminal refuse.", "TERMINAL_FORBIDDEN", 403);
    }
    try {
      const service = kioskPaymentService || getDefaultKioskPaymentService();
      const data = await service[method]({
        ...parameters(req),
        shopId: req.shopid,
        servicePointId: req.servicePointId,
      });
      return custom(res, status, "Terminal mis a jour.", null, data);
    } catch (error) {
      const safeError = error instanceof TerminalPaymentError
        ? error : new TerminalPaymentError("TERMINAL_INTERNAL_ERROR");
      return failed(res, safeError.message, safeError.code, safeError.statusCode);
    }
  };
  return {
    listReaders: handle("listReaders", () => ({})),
    registerReader: handle("registerReader", (req) => {
      const body = req.body || {};
      return {
        registrationCode: body.registrationCode, label: body.label,
        assignedUserId: body.assignedUserId, address: body.address,
        assignedServicePointId: body.assignedServicePointId,
      };
    }, { status: 201 }),
    assignReader: handle("assignReader", (req) => ({
      readerId: req.params.id, assignedUserId: (req.body || {}).assignedUserId,
      assignedServicePointId: (req.body || {}).assignedServicePointId,
    })),
    setReaderActive: handle("setReaderActive", (req) => ({
      readerId: req.params.id, isActive: (req.body || {}).isActive,
    })),
    refreshReaders: handle("refreshReaders", () => ({})),
    getCurrentReader: handle("getCurrentReader", (req) => ({ userId: req.id }), { admin: false }),
    startPayment: handle("startPayment", (req) => {
      const body = req.body || {};
      return { orderIds: body.orderIds, discountType: body.discountType, discountValue: body.discountValue };
    }, { admin: false, payment: true }),
    getPaymentStatus: handle("getPaymentStatus", (req) => ({ paymentId: req.params.id }), { admin: false, payment: true }),
    cancelPayment: handle("cancelPayment", (req) => ({ paymentId: req.params.id }), { admin: false, payment: true }),
    getKioskCurrentReader: kioskHandle("getCurrentReader", () => ({})),
    startKioskPayment: kioskHandle("startPayment", (req) => ({
      checkoutPayload: pickCheckoutPayload(req.body || {}),
    })),
    getKioskPaymentStatus: kioskHandle("getPaymentStatus", (req) => ({ paymentId: req.params.id })),
    cancelKioskPayment: kioskHandle("cancelPayment", (req) => ({ paymentId: req.params.id })),
  };
};

module.exports = { buildStripeTerminalController, ...buildStripeTerminalController() };
