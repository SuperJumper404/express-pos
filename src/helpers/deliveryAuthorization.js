const DomainError = require("./domainError");
const { parseModulePermissions } = require("./staffPermissions");

const isCourier = actor => actor && actor.subject === "staff" && Number(actor.access) === 6;
const isDeliveryOperator = actor => actor && actor.subject === "staff" &&
  (Number(actor.access) === 0 || (Number(actor.access) === 1 &&
    (parseModulePermissions(actor.module_permissions, actor.access) || []).includes("delivery")));
const forbidden = () => new DomainError(403, "DELIVERY_FORBIDDEN", "Access denied");
const assertStaffSurface = ({ access, method, path }) => {
  if (Number(access) !== 6) return;
  // Match the router-relative path: no prefix substring or HTTP-method bypass.
  const verb = String(method || "").toUpperCase();
  const pathname = String(path || "").split("?")[0].replace(/\/$/, "");
  const permitted = (verb === "GET" && (/^\/courier\/deliveries(?:\/[1-9]\d{0,19})?$/.test(pathname) ||
    ["/user/me", "/courier/cash-balance"].includes(pathname))) ||
    (verb === "POST" && (pathname === "/logout" || /^\/courier\/deliveries\/[1-9]\d{0,19}\/(pickup|deliver|report-issue|collect-payment)$/.test(pathname))) ||
    (verb === "PATCH" && pathname === "/courier/availability");
  if (!permitted) throw forbidden();
};
const assertDeliveryActor = actor => {
  if (!actor || actor.subject !== "staff" || !actor.id || !actor.shopId ||
    (!isCourier(actor) && !isDeliveryOperator(actor))) throw forbidden();
};
const assertDeliveryOwner = (actor, delivery) => {
  if (String(actor.shopId) !== String(delivery.shopid) ||
    (isCourier(actor) && String(actor.id) !== String(delivery.courier_id))) {
    throw new DomainError(404, "DELIVERY_NOT_FOUND", "Delivery not found");
  }
};
module.exports = { assertStaffSurface, assertDeliveryActor, assertDeliveryOwner, isCourier, isDeliveryOperator, forbidden };
