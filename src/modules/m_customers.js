const DomainError = require("../helpers/domainError");
const { normalizeAddress, buildDeliveryTokenCodec, validateAddressResolution, signAddressResolution } = require("../helpers/deliveryAddress");
const { isGoogleReference, toStoredAddress } = require("../helpers/deliveryAddressStorage");

const invalid = () => new DomainError(400, "CUSTOMER_REQUEST_INVALID", "Invalid customer request");
const missing = () => new DomainError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
const addressMissing = () => new DomainError(404, "CUSTOMER_ADDRESS_NOT_FOUND", "Customer address not found");
const validateId = value => {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18446744073709551615n) throw invalid();
};
const validateShop = shopId => {
  if (!Number.isInteger(shopId) || shopId < 1 || shopId > 2147483647) throw invalid();
};
const text = (value, max) => {
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value.trim().normalize("NFC");
};
const customerColumns = "CAST(id AS CHAR) AS id, shopid, name, contact_phone, contact_email, next_address_number, CAST(default_address_id AS CHAR) AS default_address_id";
const addressColumns = "CAST(id AS CHAR) AS id, CAST(customer_id AS CHAR) AS customer_id, label_number, address_snapshot";
const profileView = row => ({ id: row.id, shopId: row.shopid, name: row.name, contactPhone: row.contact_phone, contactEmail: row.contact_email });
const addressView = (row, customer) => ({ id: row.id, customerId: row.customer_id, label: `Adresse ${row.label_number}`,
  isDefault: row.id === customer.default_address_id,
  addressSnapshot: typeof row.address_snapshot === "string" ? JSON.parse(row.address_snapshot) : row.address_snapshot });

const buildSqlCustomersRepository = ({ pool = require("../config/dbPool") } = {}) => ({
  async getCustomer({ shopId, customerId, connection }) {
    const [[row]] = await connection.query(`SELECT ${customerColumns} FROM customers WHERE shopid = ? AND id = ? FOR UPDATE`, [shopId, customerId]);
    return row;
  },
  async listAddresses({ shopId, customerId, connection }) {
    const [rows] = await connection.query(`SELECT ${addressColumns} FROM customer_addresses WHERE shopid = ? AND customer_id = ? ORDER BY label_number`, [shopId, customerId]);
    return rows;
  },
  async getAddress({ shopId, customerId, addressId, connection }) {
    const [[row]] = await connection.query(`SELECT ${addressColumns} FROM customer_addresses WHERE shopid = ? AND customer_id = ? AND id = ?`, [shopId, customerId, addressId]);
    return row;
  },
  async insertAddress({ shopId, customerId, labelNumber, addressSnapshot, connection }) {
    await connection.query("INSERT INTO customer_addresses (shopid,customer_id,label_number,address_snapshot) VALUES (?,?,?,?)", [shopId, customerId, labelNumber, JSON.stringify(addressSnapshot)]);
    // mysql2's numeric insertId can already be rounded; read on this exact connection.
    const [[row]] = await connection.query("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
    return row.id;
  },
  updateAddress: ({ shopId, customerId, addressId, addressSnapshot, connection }) => connection.query(
    "UPDATE customer_addresses SET address_snapshot = ?, updated_at = UTC_TIMESTAMP() WHERE shopid = ? AND customer_id = ? AND id = ?", [JSON.stringify(addressSnapshot), shopId, customerId, addressId]),
  updateCustomerAddresses: ({ shopId, customerId, nextAddressNumber, defaultAddressId, connection }) => connection.query(
    "UPDATE customers SET next_address_number = ?, default_address_id = ?, updated_at = UTC_TIMESTAMP() WHERE shopid = ? AND id = ?", [nextAddressNumber, defaultAddressId, shopId, customerId]),
  deleteAddress: ({ shopId, customerId, addressId, connection }) => connection.query("DELETE FROM customer_addresses WHERE shopid = ? AND customer_id = ? AND id = ?", [shopId, customerId, addressId]),
  async searchProfiles({ shopId, query }) {
    const pattern = `%${query.replace(/[!%_]/g, value => `!${value}`)}%`;
    const [rows] = await pool.query(`SELECT ${customerColumns} FROM customers WHERE shopid = ? AND
      (name LIKE ? ESCAPE '!' OR contact_phone LIKE ? ESCAPE '!' OR contact_email LIKE ? ESCAPE '!') ORDER BY id DESC LIMIT 50`, [shopId, pattern, pattern, pattern]);
    return rows;
  },
  async insertProfile({ shopId, name, contactPhone, contactEmail, connection }) {
    await connection.query("INSERT INTO customers (shopid,name,contact_phone,contact_email) VALUES (?,?,?,?)", [shopId, name, contactPhone, contactEmail]);
    const [[row]] = await connection.query("SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id");
    return row.id;
  },
});

const buildCustomers = ({ repository = buildSqlCustomersRepository(), runInTransaction = require("../helpers/withTransaction").withTransaction,
  clock = () => new Date(), tokenCodec = buildDeliveryTokenCodec(), places = require("../services/googleDeliveryPlaces").googleDeliveryPlaces } = {}) => {
  const owned = async ({ shopId, customerId, connection }) => {
    validateShop(shopId);
    validateId(customerId);
    const customer = await repository.getCustomer({ shopId, customerId, connection });
    if (!customer) throw missing();
    return customer;
  };
  const address = async scope => {
    validateId(scope.addressId);
    const row = await repository.getAddress(scope);
    if (!row) throw addressMissing();
    return row;
  };
  return {
    async createProfile({ shopId, name = "", contactPhone = "", contactEmail = "" }) {
      validateShop(shopId);
      const profile = { shopId, name: text(name, 255), contactPhone: text(contactPhone, 255), contactEmail: text(contactEmail, 254) };
      if (!profile.name && !profile.contactPhone && !profile.contactEmail) throw invalid();
      return runInTransaction(async connection => {
        const customerId = await repository.insertProfile({ ...profile, connection });
        return profileView(await owned({ shopId, customerId, connection }));
      });
    },
    async searchProfiles({ shopId, query = "" }) {
      validateShop(shopId);
      return (await repository.searchProfiles({ shopId, query: text(query, 255) })).map(profileView);
    },
    listAddresses: ({ shopId, customerId }) => runInTransaction(async connection => {
      const customer = await owned({ shopId, customerId, connection });
      return (await repository.listAddresses({ shopId, customerId, connection })).map(row => addressView(row, customer));
    }),
    saveAddress: ({ shopId, customerId, addressId = null, addressResolutionToken, complement, instructions, makeDefault = false }) => runInTransaction(async connection => {
      const scope = { shopId, customerId, connection };
      const customer = await owned(scope);
      if (typeof makeDefault !== "boolean") throw invalid();
      const current = addressId === null ? null : await address({ ...scope, addressId });
      let snapshot;
      if (addressResolutionToken !== undefined) {
        snapshot = validateAddressResolution(addressResolutionToken, clock(), { tokenCodec, shopId });
      } else if (current) snapshot = addressView(current, customer).addressSnapshot;
      else throw new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Resolve the postal address before saving it");
      // The signed postal/provider/precision snapshot is copied whole. Only these
      // private fields can change without another postal resolution.
      snapshot = { ...snapshot };
      if (complement !== undefined) snapshot.complement = text(complement, 255);
      if (instructions !== undefined) snapshot.instructions = text(instructions, 1000);
      if (snapshot.provider === "google_places") snapshot = toStoredAddress(snapshot, { purpose: "book" });
      else normalizeAddress(snapshot);
      if (current) await repository.updateAddress({ ...scope, addressId, addressSnapshot: snapshot });
      else {
        if (customer.next_address_number >= 4294967295) throw invalid();
        addressId = await repository.insertAddress({ ...scope, labelNumber: customer.next_address_number, addressSnapshot: snapshot });
        customer.next_address_number++;
      }
      if (makeDefault || customer.default_address_id === null) customer.default_address_id = addressId;
      await repository.updateCustomerAddresses({ ...scope, nextAddressNumber: customer.next_address_number, defaultAddressId: customer.default_address_id });
      return addressView(await address({ ...scope, addressId }), customer);
    }),
    deleteAddress: ({ shopId, customerId, addressId }) => runInTransaction(async connection => {
      const scope = { shopId, customerId, connection };
      const customer = await owned(scope);
      await address({ ...scope, addressId });
      if (customer.default_address_id === addressId) {
        const remaining = (await repository.listAddresses(scope)).filter(row => row.id !== addressId);
        await repository.updateCustomerAddresses({ ...scope, nextAddressNumber: customer.next_address_number, defaultAddressId: remaining.length ? remaining[0].id : null });
      }
      await repository.deleteAddress({ ...scope, addressId });
      return { id: addressId };
    }),
    async resolveStoredAddress({ shopId, customerId, addressId }) {
      tokenCodec.sign({ kind: "preflight" });
      let addressSnapshot = await runInTransaction(async connection => {
      const scope = { shopId, customerId, connection };
      const customer = await owned(scope);
      return addressView(await address({ ...scope, addressId }), customer).addressSnapshot;
      });
      if (isGoogleReference(addressSnapshot)) {
        const resolved = await places.resolve({ shopId, placeId: addressSnapshot.placeId });
        addressSnapshot = { ...resolved, ...toStoredAddress(addressSnapshot, { purpose: "book" }) };
      }
      const now = clock();
      return { addressSnapshot,
        addressResolutionToken: signAddressResolution({ shopId, addressSnapshot, now, tokenCodec }),
        expiresAt: new Date(new Date(now).getTime() + 900000).toISOString() };
    },
  };
};

module.exports = { buildCustomers, buildSqlCustomersRepository };
