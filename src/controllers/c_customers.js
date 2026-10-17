const DomainError = require("../helpers/domainError");
const { custom, failed } = require("../helpers/response");
const { isDeliveryOperator, forbidden } = require("../helpers/deliveryAuthorization");

const bodyFields = (req, allowed) => {
  const body = req.body || {};
  if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    throw new DomainError(400, "CUSTOMER_REQUEST_INVALID", "Invalid customer request");
  }
  return body;
};
const buildCustomersController = ({ customers = require("../modules/m_customers").buildCustomers() } = {}) => {
  const endpoint = work => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const user = req.currentUser;
      if (req.sessionSubject !== "staff" || !user || user.access == null || Number(user.status) !== 1
        || String(user.id) !== String(req.id) || String(user.shopid) !== String(req.shopid)
        || !isDeliveryOperator({ subject: "staff", access: user.access, module_permissions: user.module_permissions })) throw forbidden();
      return custom(res, 200, "OK", null, await work(req));
    } catch (error) {
      if (error instanceof DomainError) return failed(res, error.message, error.code, error.status);
      return failed(res, "Customer service unavailable", "CUSTOMER_UNAVAILABLE", 503);
    }
  };
  const scope = req => ({ shopId: req.shopid, customerId: req.params.customerId });
  return {
    searchProfiles: endpoint(req => {
      if (Object.keys(req.query).some(key => key !== "q")) throw new DomainError(400, "CUSTOMER_REQUEST_INVALID", "Invalid customer search");
      return customers.searchProfiles({ shopId: req.shopid, query: req.query.q });
    }),
    createProfile: endpoint(req => customers.createProfile({ shopId: req.shopid, ...bodyFields(req, ["name", "contactPhone", "contactEmail"]) })),
    listAddresses: endpoint(req => customers.listAddresses(scope(req))),
    saveAddress: endpoint(req => customers.saveAddress({ ...scope(req), addressId: req.params.addressId || null,
      ...bodyFields(req, ["addressResolutionToken", "complement", "instructions", "makeDefault"]) })),
    deleteAddress: endpoint(req => { bodyFields(req, []); return customers.deleteAddress({ ...scope(req), addressId: req.params.addressId }); }),
    resolveStoredAddress: endpoint(req => { bodyFields(req, []); return customers.resolveStoredAddress({ ...scope(req), addressId: req.params.addressId }); }),
  };
};

const buildCustomerAuthController = ({ customerAuth = require("../modules/m_customerAuth").buildCustomerAuth(),
  transports = require("../services/customerCodeTransports").buildCustomerCodeTransports(),
  sessions = require("../helpers/customerSession").buildCustomerSession() } = {}) => {
  const endpoint = work => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { return custom(res, 200, "OK", null, await work(req)); }
    catch (error) {
      if (error instanceof DomainError) return failed(res, error.message, error.code, error.status);
      return failed(res, "Customer authentication unavailable", "CUSTOMER_AUTH_UNAVAILABLE", 503);
    }
  };
  return {
    channels: endpoint(() => transports.channels()),
    requestChallenge: endpoint(req => {
      const body = bodyFields(req, ["shopId", "channel", "destination", "countryCode", "browserBinding", "locale"]);
      return customerAuth.requestChallenge({ ...body, ip: req.ip, purpose: "login", customerId: null });
    }),
    verify: endpoint(async req => {
      const body = bodyFields(req, ["shopId", "challengeId", "code", "browserBinding"]);
      if (!require("../helpers/middleware/customerAuth").cookiePolicy(req)) throw new DomainError(503, "CUSTOMER_SESSION_UNAVAILABLE", "Secure customer transport required");
      const owner = await customerAuth.verifyChallenge(body);
      const created = await sessions.create(owner);
      require("../helpers/middleware/customerAuth").setCustomerCookie(req, req.res, created.rawToken, created.session.expiresAt);
      return sessionView(created.session, created.csrfToken);
    }),
    session: endpoint(req => sessionView(req.customerSession, sessions.csrfToken(req.customerSession))),
    logout: endpoint(async req => {
      bodyFields(req, []);
      const { rawCustomerToken, setCustomerCookie } = require("../helpers/middleware/customerAuth");
      await sessions.revoke({ rawToken: rawCustomerToken(req), shopId: req.customerSession.shopId });
      setCustomerCookie(req, req.res, null);
      return { loggedOut: true };
    }),
    requestLinkChallenge: endpoint(req => {
      const body = bodyFields(req, ["channel", "destination", "countryCode", "browserBinding", "locale"]);
      return customerAuth.requestChallenge({ ...body, shopId: req.customerSession.shopId, customerId: req.customerSession.customerId,
        ip: req.ip, purpose: "link" });
    }),
    verifyLink: endpoint(async req => {
      const body = bodyFields(req, ["challengeId", "code", "browserBinding"]);
      await customerAuth.linkIdentity({ customerSession: req.customerSession, ...body });
      return { linked: true };
    }),
  };
};

const sessionView = (session, csrfToken) => ({ subject: "customer", shopId: session.shopId,
  customerId: session.customerId, expiresAt: session.expiresAt, csrfToken });

const buildPersonalCustomersController = ({ customers, quotes,
  sessionRepository = require("../helpers/customerSession").buildSqlCustomerSessionRepository() } = {}) => {
  const service = req => customers || require("../modules/m_customers").buildCustomers({
    runInTransaction: work => sessionRepository.transactionForShop({ shopId: req.customerSession.shopId }, work),
  });
  const endpoint = work => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { return custom(res, 200, "OK", null, await work(req)); }
    catch (error) {
      if (error instanceof DomainError) {
        if (error.candidates && error.candidates.length) return res.status(error.status).json({ code: error.status, success: false,
          message: error.message, pagination: null, data: { candidates: error.candidates }, error: error.code });
        return failed(res, error.message, error.code, error.status);
      }
      return failed(res, "Customer service unavailable", "CUSTOMER_UNAVAILABLE", 503);
    }
  };
  const scope = req => ({ shopId: req.customerSession.shopId, customerId: req.customerSession.customerId });
  return {
    listAddresses: endpoint(req => service(req).listAddresses(scope(req))),
    saveAddress: endpoint(req => service(req).saveAddress({ ...scope(req), addressId: req.params.addressId || null,
      ...bodyFields(req, ["addressResolutionToken", "complement", "instructions", "makeDefault"]) })),
    deleteAddress: endpoint(req => { bodyFields(req, []); return service(req).deleteAddress({ ...scope(req), addressId: req.params.addressId }); }),
    resolveAddress: endpoint(req => {
      const body = bodyFields(req, ["addressId", "address", "candidateId"]);
      if (Object.prototype.hasOwnProperty.call(body, "addressId")) {
        if (Object.keys(body).length !== 1) throw new DomainError(400, "CUSTOMER_REQUEST_INVALID", "Choose a stored or new address");
        return service(req).resolveStoredAddress({ ...scope(req), addressId: body.addressId });
      }
      if (!body.address || typeof body.address !== "object" || Array.isArray(body.address)
        || Object.keys(body.address).some(key => !["street", "postalCode", "city", "country", "complement", "instructions"].includes(key))) {
        throw new DomainError(400, "CUSTOMER_REQUEST_INVALID", "Invalid postal address");
      }
      return (quotes || require("../modules/m_deliveryQuotes").buildDeliveryQuotes()).resolveAddress({
        shopId: req.customerSession.shopId, address: body.address, candidateId: body.candidateId });
    }),
  };
};

module.exports = { buildCustomersController, buildCustomerAuthController, buildPersonalCustomersController };
