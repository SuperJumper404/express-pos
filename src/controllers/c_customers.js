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

module.exports = { buildCustomersController };
