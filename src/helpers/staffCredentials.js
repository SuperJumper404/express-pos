const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { customAlphabet } = require("nanoid");

const STAFF_LOGIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const createStaffLoginId = customAlphabet(STAFF_LOGIN_ALPHABET, 6);
const createStaffPin = () => String(crypto.randomInt(0, 10000)).padStart(4, "0");

const normalizeStaffLoginId = (value) =>
  String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const isValidStaffPin = (value) => /^\d{4}$/.test(String(value || ""));

const hashStaffPin = (pin) => bcrypt.hash(pin, 10);
const verifyStaffPin = (pin, hash) => bcrypt.compare(pin, hash);

module.exports = {
  STAFF_LOGIN_ALPHABET,
  createStaffLoginId,
  createStaffPin,
  normalizeStaffLoginId,
  isValidStaffPin,
  hashStaffPin,
  verifyStaffPin,
};
