const DomainError = require("../helpers/domainError");
const { validateDeliverySettings } = require("../helpers/deliveryPricing");
const { validateAddressResolution } = require("../helpers/deliveryAddress");

const defaultSettings = (shopId) => ({
  shopId, revision: 0, enabled: false, origin: null, maxDistanceMeters: 0, minimumItemsCents: 0,
  freeDeliveryEnabled: false, freeDeliveryThresholdCents: null,
  fiscalPolicy: { mode: "configured_rate", vatRate: null }, bands: [],
});
const buildSqlDeliverySettingsRepository = ({ pool = require("../config/dbPool") } = {}) => {
  const getSettings = async ({ shopId, connection = pool }) => {
    // Explicit projections keep new BIGINT identifiers out of the legacy pool's number parser.
    const [rows] = await connection.query(
      `SELECT s.revision, s.enabled, s.origin_latitude, s.origin_longitude, s.max_distance_meters,
       CAST(s.minimum_items_cents AS CHAR) AS minimum_items_cents, s.free_delivery_enabled,
       CAST(s.free_delivery_threshold_cents AS CHAR) AS free_delivery_threshold_cents,
       s.fiscal_mode, s.vat_rate, b.up_to_meters, CAST(b.fee_cents AS CHAR) AS fee_cents
       FROM shop_delivery_settings s LEFT JOIN shop_delivery_fee_bands b ON b.shopid = s.shopid
       WHERE s.shopid = ? ORDER BY b.up_to_meters`, [shopId],
    );
    if (!rows.length) return defaultSettings(shopId);
    const row = rows[0];
    return {
      shopId, revision: row.revision, enabled: row.enabled === 1,
      origin: row.origin_latitude === null ? null : { latitude: Number(row.origin_latitude), longitude: Number(row.origin_longitude) },
      maxDistanceMeters: row.max_distance_meters, minimumItemsCents: Number(row.minimum_items_cents),
      freeDeliveryEnabled: row.free_delivery_enabled === 1,
      freeDeliveryThresholdCents: row.free_delivery_threshold_cents === null ? null : Number(row.free_delivery_threshold_cents),
      fiscalPolicy: { mode: row.fiscal_mode, vatRate: row.vat_rate === null ? null : Number(row.vat_rate) },
      bands: rows.filter(value => value.up_to_meters !== null).map(value => ({ upToMeters: value.up_to_meters, feeCents: Number(value.fee_cents) })),
    };
  };
  return {
    getSettings,
    async saveSettings({ shopId, expectedRevision, settings }) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        // Lock the legacy parent too: it serializes first configuration when no settings row exists yet.
        const [[shop]] = await connection.query("SELECT id FROM shop WHERE id = ? FOR UPDATE", [shopId]);
        if (!shop) throw new DomainError(404, "SHOP_NOT_FOUND", "Shop not found");
        const [[current]] = await connection.query("SELECT revision FROM shop_delivery_settings WHERE shopid = ? FOR UPDATE", [shopId]);
        if ((current ? current.revision : 0) !== expectedRevision) throw new DomainError(409, "DELIVERY_VERSION_CONFLICT", "Delivery settings changed");
        if (!current) await connection.query("INSERT INTO shop_delivery_settings (shopid) VALUES (?)", [shopId]);
        await connection.query(
          `UPDATE shop_delivery_settings SET revision = ?, enabled = ?, origin_latitude = ?, origin_longitude = ?,
           max_distance_meters = ?, minimum_items_cents = ?, free_delivery_enabled = ?, free_delivery_threshold_cents = ?, fiscal_mode = ?, vat_rate = ? WHERE shopid = ?`,
          [expectedRevision + 1, settings.enabled ? 1 : 0, settings.origin && settings.origin.latitude, settings.origin && settings.origin.longitude,
            settings.maxDistanceMeters, String(settings.minimumItemsCents), settings.freeDeliveryEnabled ? 1 : 0,
            settings.freeDeliveryThresholdCents === null ? null : String(settings.freeDeliveryThresholdCents), settings.fiscalPolicy.mode, settings.fiscalPolicy.vatRate, shopId],
        );
        await connection.query("DELETE FROM shop_delivery_fee_bands WHERE shopid = ?", [shopId]);
        for (const band of settings.bands) await connection.query("INSERT INTO shop_delivery_fee_bands (shopid, up_to_meters, fee_cents) VALUES (?, ?, ?)", [shopId, band.upToMeters, String(band.feeCents)]);
        const result = await getSettings({ shopId, connection });
        await connection.commit();
        return result;
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    },
  };
};
const buildDeliverySettings = ({ repository = buildSqlDeliverySettingsRepository(), tokenCodec, clock = () => new Date() } = {}) => ({
  getSettings: input => repository.getSettings(input),
  async updateSettings({ shopId, expectedRevision, settings }) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 4294967295 || !settings) throw new DomainError(422, "DELIVERY_SETTINGS_INVALID", "Expected settings revision is required");
    const current = await repository.getSettings({ shopId });
    if (current.revision !== expectedRevision) throw new DomainError(409, "DELIVERY_VERSION_CONFLICT", "Delivery settings changed");
    let origin = settings.origin;
    if (settings.originResolutionToken) {
      const resolved = validateAddressResolution(settings.originResolutionToken, clock(), { tokenCodec, shopId });
      origin = { latitude: resolved.latitude, longitude: resolved.longitude };
    } else if (origin !== null && (!current.origin || !origin || origin.latitude !== current.origin.latitude || origin.longitude !== current.origin.longitude)) {
      throw new DomainError(422, "DELIVERY_ADDRESS_INVALID", "Resolve restaurant address before changing its position");
    }
    const normalized = validateDeliverySettings({
      shopId, revision: expectedRevision, enabled: settings.enabled, origin,
      maxDistanceMeters: settings.maxDistanceMeters, minimumItemsCents: settings.minimumItemsCents,
      freeDeliveryEnabled: settings.freeDeliveryEnabled, freeDeliveryThresholdCents: settings.freeDeliveryThresholdCents,
      fiscalPolicy: settings.fiscalPolicy, bands: settings.bands,
    });
    return repository.saveSettings({ shopId, expectedRevision, settings: normalized });
  },
});
module.exports = { defaultSettings, buildSqlDeliverySettingsRepository, buildDeliverySettings };
