const assert = require("assert");
const { nextReservationStatus } = require("../src/helpers/reservationLifecycle");

assert.strictEqual(nextReservationStatus("reserved", "commit"), "committed");
assert.strictEqual(nextReservationStatus("reserved", "release"), "released");
assert.throws(() => nextReservationStatus("committed", "release"), /transition/i);
assert.strictEqual(nextReservationStatus("committed", "commit"), "committed");
assert.strictEqual(nextReservationStatus("released", "release"), "released");
assert.throws(() => nextReservationStatus("released", "commit"), /transition/i);

console.log("reservation lifecycle tests passed");
