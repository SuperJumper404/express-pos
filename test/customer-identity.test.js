const assert = require("assert/strict");
const { test } = require("node:test");
const { normalizeCustomerDestination } = require("../src/helpers/customerIdentity");

test("email normalization preserves mailbox distinctions and canonicalizes only the domain", () => {
  for (const [value, expected] of [
    ["  Alice.Name+shop@EXAMPLE.COM  ", "Alice.Name+shop@example.com"],
    ["alice.name+shop@example.com", "alice.name+shop@example.com"],
    ["Alice@b\u00fccher.DE", "Alice@xn--bcher-kva.de"],
    ["Alice.Name+shop@XN--BCHER-KVA.DE", "Alice.Name+shop@xn--bcher-kva.de"],
    ["Alice%tag+shop@EXAMPLE.COM", "Alice%tag+shop@example.com"],
  ]) assert.equal(normalizeCustomerDestination({ channel: "email", value }), expected);
});

for (const value of [
  "a@example.com/path", "a@example.com?x=1", "a@example.com#x", "a@example.com\\evil", "a@example.com:443",
  "a@%65xample.com", "a@ex%61mple.com", "a@example%2ecom", "a@example.com%2fpath",
  "a@example.com%3fx=1", "a@example.com%23x", "a@example.com%5cevil", "a@example.com/%65vil", "a@example.com%25evil",
]) {
  test(`email domain rejects URL syntax and escapes: ${value}`, () => {
    assert.throws(() => normalizeCustomerDestination({ channel: "email", value }), { code: "CUSTOMER_DESTINATION_INVALID" });
  });
}

test("phone normalization uses strict whole-input max metadata and E164", () => {
  for (const [value, countryCode, expected] of [
    ["06 12 34 56 78", "FR", "+33612345678"],
    ["+1 (213) 373-4253", undefined, "+12133734253"],
    ["020 7946 0018", "GB", "+442079460018"],
    ["+33 6 12 34 56 78", "GB", "+33612345678"],
  ]) assert.equal(normalizeCustomerDestination({ channel: "whatsapp", value, countryCode }), expected);
});

test("invalid destinations, extracted numbers, extensions and unknown channels are refused", () => {
  for (const input of [
    { channel: "unknown", value: "+33612345678" },
    ...["call +33612345678", "+33612345678 call me", "+33612345678 ext. 1", "+33612345678 x123",
      "tel:+33612345678;ext=12", "+33700000000", "+5511555555555", "+999123456789", "123", "0612345678\n"].map(value => ({ channel: "whatsapp", value })),
    { channel: "whatsapp", value: "0612345678", countryCode: "XX" },
    { channel: "whatsapp", value: "0612345678" },
    ...["", "a@", "@example.com", "a@@example.com", "a@-bad.com", "a@example..com", "a b@example.com",
      "Alice <a@example.com>", "a\r\n@example.com", "a".repeat(65) + "@example.com", "a.@example.com", ".a@example.com", "a..b@example.com"].map(value => ({ channel: "email", value })),
    { channel: "email", value: null },
  ]) assert.throws(() => normalizeCustomerDestination(input), { code: "CUSTOMER_DESTINATION_INVALID" });
});
