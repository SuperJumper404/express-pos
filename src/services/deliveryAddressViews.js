const { isGoogleReference } = require("../helpers/deliveryAddressStorage");
const buildDeliveryAddressViews = ({ places = require("./googleDeliveryPlaces").googleDeliveryPlaces } = {}) => ({
  async hydrate({ shopId, addressSnapshot }) {
    if (!isGoogleReference(addressSnapshot) || addressSnapshot.street) return { addressSnapshot, displayStatus: "ready" };
    try {
      const resolved = await places.resolve({ shopId, placeId: addressSnapshot.placeId });
      return { addressSnapshot: { ...addressSnapshot, ...Object.fromEntries(["street", "postalCode", "city", "country"].map(key => [key, resolved[key]])) }, displayStatus: "ready" };
    } catch (error) {
      return { addressSnapshot, displayStatus: error.code === "DELIVERY_ADDRESS_INVALID" ? "invalid" : "unavailable" };
    }
  },
});
module.exports = { buildDeliveryAddressViews };
