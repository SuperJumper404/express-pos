const { domainToASCII } = require("url");
const { parsePhoneNumberFromString, isSupportedCountry } = require("libphonenumber-js/max");
const DomainError = require("./domainError");

const invalid = () => new DomainError(422, "CUSTOMER_DESTINATION_INVALID", "Invalid customer destination");
const normalizeCustomerDestination = ({ channel, value, countryCode } = {}) => {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  const input = value.trim();
  if (channel === "email") {
    const parts = input.split("@");
    if (parts.length !== 2) throw invalid();
    const [local, rawDomain] = parts;
    const domain = domainToASCII(rawDomain).toLowerCase();
    if (!local || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
      || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !domain || domain.length > 253
      || !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || !domain.includes(".") || `${local}@${domain}`.length > 254) throw invalid();
    return `${local}@${domain}`;
  }
  if (channel !== "whatsapp" || input.length > 250
    || (countryCode !== undefined && (typeof countryCode !== "string" || !isSupportedCountry(countryCode)))) throw invalid();
  const phone = parsePhoneNumberFromString(input, { defaultCountry: countryCode, extract: false });
  if (!phone || phone.ext || !phone.isValid()) throw invalid();
  return phone.number;
};

module.exports = { normalizeCustomerDestination };
