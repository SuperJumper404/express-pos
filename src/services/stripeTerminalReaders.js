const { isStaffAccess } = require("../helpers/staffAccess");

const ERRORS = {
  TERMINAL_INVALID_INPUT: [422, "Parametres du terminal invalides."],
  TERMINAL_FORBIDDEN: [403, "Acces au terminal refuse."],
  TERMINAL_INVALID_ASSIGNEE: [422, "Le compte assigne doit etre un employe actif du restaurant."],
  TERMINAL_ASSIGNMENT_CONFLICT: [409, "Cette affectation de terminal est deja utilisee."],
  TERMINAL_READER_NOT_FOUND: [404, "Terminal introuvable."],
  TERMINAL_READER_INACTIVE: [409, "Ce terminal est desactive."],
  TERMINAL_STRIPE_ERROR: [502, "Le service de terminaux Stripe est indisponible. Veuillez reessayer."],
  TERMINAL_INTERNAL_ERROR: [500, "Impossible de gerer le terminal."],
};

class TerminalReaderError extends Error {
  constructor(code) {
    super(ERRORS[code][1]);
    this.code = code;
    this.statusCode = ERRORS[code][0];
  }
}

const fail = (code) => { throw new TerminalReaderError(code); };
const positiveId = (value) => {
  if (!((typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0)) {
    fail("TERMINAL_INVALID_INPUT");
  }
  return Number(value);
};
const requiredText = (value, maxLength) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    fail("TERMINAL_INVALID_INPUT");
  }
  return value.trim();
};
const normalizeAddress = (address) => {
  if (!address || typeof address !== "object" || Array.isArray(address) || address.country !== "FR") {
    fail("TERMINAL_INVALID_INPUT");
  }
  const result = {
    line1: requiredText(address.line1, 255),
    postalCode: requiredText(address.postalCode, 5),
    city: requiredText(address.city, 128),
    country: "FR",
  };
  if (!/^\d{5}$/.test(result.postalCode)) fail("TERMINAL_INVALID_INPUT");
  return result;
};
const stripeAddress = (address) => ({
  line1: address.line1, postal_code: address.postalCode, city: address.city, country: address.country,
});
const readerStatus = (status) => status === "online" ? "online" : "offline";
const readerDto = (reader) => ({
  id: reader.id,
  label: reader.label,
  serialNumber: reader.serial_number || null,
  deviceType: reader.device_type || null,
  status: readerStatus(reader.status),
  assignedUserId: reader.assigned_user_id == null ? null : reader.assigned_user_id,
  assignedServicePointId: reader.assigned_service_point_id == null ? null : reader.assigned_service_point_id,
  isActive: Number(reader.is_active) === 1,
});
const activeStaff = (user, shopId, userId) => user
  && Number(user.shopid) === shopId && Number(user.id) === userId
  && user.access != null && isStaffAccess(user.access) && Number(user.status) === 1;

const buildStripeTerminalReaderService = ({ stripe, terminalStore, staffStore }) => {
  // Only application-owned errors leave this boundary; never retain a raw error as cause.
  const safe = (operation) => async (input) => {
    try {
      return await operation(input);
    } catch (error) {
      if (error instanceof TerminalReaderError) throw error;
      fail(error && error.code === "ER_DUP_ENTRY"
        ? "TERMINAL_ASSIGNMENT_CONFLICT" : "TERMINAL_INTERNAL_ERROR");
    }
  };
  const stripeCall = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      fail("TERMINAL_STRIPE_ERROR");
    }
  };
  const requireAdmin = async (input) => {
    const shopId = positiveId(input.shopId);
    const id = positiveId(input.actorUserId);
    const user = await staffStore.findUserByIdAndShop({ id, shopId });
    if (!activeStaff(user, shopId, id) || Number(user.access) !== 0) fail("TERMINAL_FORBIDDEN");
    return shopId;
  };
  const requireAssignee = async (shopId, userId, readerId = null) => {
    const user = await staffStore.findUserByIdAndShop({ id: userId, shopId });
    if (!activeStaff(user, shopId, userId)) fail("TERMINAL_INVALID_ASSIGNEE");
    const assigned = await terminalStore.findAssignedReader({ shopId, userId });
    if (assigned && Number(assigned.id) !== readerId) fail("TERMINAL_ASSIGNMENT_CONFLICT");
  };
  const requireReader = async (shopId, readerId) => {
    const reader = await terminalStore.findReader({ shopId, readerId });
    if (!reader || Number(reader.shopid) !== shopId) fail("TERMINAL_READER_NOT_FOUND");
    return reader;
  };
  const readDto = async (shopId, readerId) => readerDto(await requireReader(shopId, readerId));

  const listReaders = safe(async (input) => {
    const shopId = await requireAdmin(input);
    return (await terminalStore.listReaders({ shopId })).map(readerDto);
  });

  const registerReader = safe(async (input) => {
    const shopId = await requireAdmin(input);
    const registrationCode = requiredText(input.registrationCode, 500);
    const label = requiredText(input.label, 255);
    const assignedUserId = positiveId(input.assignedUserId);
    if (input.assignedServicePointId != null) fail("TERMINAL_INVALID_INPUT");
    let location = await terminalStore.findLocation({ shopId });
    const address = input.address === undefined && location ? null : normalizeAddress(input.address);
    await requireAssignee(shopId, assignedUserId);

    if (!location) {
      const displayName = `Restaurant ${shopId}`;
      const created = await stripeCall(() => stripe.terminal.locations.create({
        display_name: displayName, address: stripeAddress(address),
      }));
      const saved = await terminalStore.createLocation({ shopId, stripeLocationId: created.id, displayName, address });
      location = { id: saved.insertId, stripe_location_id: created.id };
    } else if (address && (location.address_line1 !== address.line1
      || location.postal_code !== address.postalCode || location.city !== address.city
      || location.country !== address.country)) {
      await stripeCall(() => stripe.terminal.locations.update(location.stripe_location_id, {
        address: stripeAddress(address),
      }));
      await terminalStore.updateLocation({
        shopId, stripeLocationId: location.stripe_location_id, displayName: location.display_name, address,
      });
    }

    const registered = await stripeCall(() => stripe.terminal.readers.create({
      registration_code: registrationCode, label, location: location.stripe_location_id,
    }));
    const saved = await terminalStore.createReader({
      shopId, locationId: location.id, stripeReaderId: registered.id,
      serialNumber: registered.serial_number, deviceType: registered.device_type,
      label, status: readerStatus(registered.status), assignedUserId, assignedServicePointId: null,
    });
    return readDto(shopId, saved.insertId);
  });

  const assignReader = safe(async (input) => {
    const shopId = await requireAdmin(input);
    const readerId = positiveId(input.readerId);
    const assignedUserId = positiveId(input.assignedUserId);
    if (input.assignedServicePointId != null) fail("TERMINAL_INVALID_INPUT");
    const reader = await requireReader(shopId, readerId);
    if (Number(reader.is_active) !== 1) fail("TERMINAL_READER_INACTIVE");
    if (reader.assigned_service_point_id != null) fail("TERMINAL_ASSIGNMENT_CONFLICT");
    await requireAssignee(shopId, assignedUserId, readerId);
    await terminalStore.updateReader({ shopId, readerId, assignedUserId });
    return readDto(shopId, readerId);
  });

  const setReaderActive = safe(async (input) => {
    const shopId = await requireAdmin(input);
    const readerId = positiveId(input.readerId);
    if (typeof input.isActive !== "boolean") fail("TERMINAL_INVALID_INPUT");
    const reader = await requireReader(shopId, readerId);
    if (input.isActive && reader.assigned_user_id != null) {
      await requireAssignee(shopId, positiveId(reader.assigned_user_id), readerId);
    }
    await terminalStore.updateReader({ shopId, readerId, isActive: input.isActive ? 1 : 0 });
    return readDto(shopId, readerId);
  });

  const refreshReaders = safe(async (input) => {
    const shopId = await requireAdmin(input);
    const readers = await terminalStore.listReaders({ shopId });
    for (const reader of readers) {
      const remote = await stripeCall(() => stripe.terminal.readers.retrieve(reader.stripe_reader_id));
      await terminalStore.updateReader({ shopId, readerId: reader.id, status: readerStatus(remote.status) });
    }
    return (await terminalStore.listReaders({ shopId })).map(readerDto);
  });

  const getCurrentReader = safe(async (input) => {
    const shopId = positiveId(input.shopId);
    const userId = positiveId(input.userId);
    const user = await staffStore.findUserByIdAndShop({ id: userId, shopId });
    if (!activeStaff(user, shopId, userId)) fail("TERMINAL_FORBIDDEN");
    const reader = await terminalStore.findAssignedReader({ shopId, userId });
    return reader && Number(reader.shopid) === shopId && Number(reader.is_active) === 1
      && Number(reader.assigned_user_id) === userId ? readerDto(reader) : null;
  });

  return { listReaders, registerReader, assignReader, setReaderActive, refreshReaders, getCurrentReader };
};

module.exports = { buildStripeTerminalReaderService, TerminalReaderError };
