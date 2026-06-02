const Stripe = require("stripe");
const { envSTRIPESECRETKEY } = require("../helpers/env");

let stripe = null;

const getStripe = () => {
  if (!envSTRIPESECRETKEY) {
    throw new Error("STRIPE_SECRET_KEY manquant");
  }

  if (!stripe) {
    stripe = Stripe(envSTRIPESECRETKEY);
  }

  return stripe;
};

module.exports = { getStripe };
