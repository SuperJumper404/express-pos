const buildStripeTerminalMaintenance = ({ terminalStore, paymentService, kioskPaymentService, logger = console }) => async () => {
  const payments = await terminalStore.listExpiredCardWaitPayments();
  for (const payment of payments) {
    try {
      const service = Number(payment.cashier_user_id) === 0 && payment.payment_kind !== 'standalone'
        ? kioskPaymentService : paymentService;
      await service.maintainPayment(payment);
    } catch (error) {
      // Keep active reservations on ambiguous Stripe/database failures and retry
      // on the next tick. Never free a reader based on a local timer alone.
      logger.error('Terminal card wait verification will be retried', { paymentId: payment.id, shopId: payment.shopid });
    }
  }
};

let maintenance;
const runStripeTerminalMaintenance = () => {
  if (!maintenance) {
    const { buildStripeTerminalModule } = require('../modules/m_stripeTerminal');
    const { getDefaultPaymentService, getDefaultKioskPaymentService } = require('../controllers/c_stripeTerminal');
    maintenance = buildStripeTerminalMaintenance({
      terminalStore: buildStripeTerminalModule({ connection: require('../config/dbPool') }),
      paymentService: getDefaultPaymentService(), kioskPaymentService: getDefaultKioskPaymentService(),
    });
  }
  return maintenance();
};

module.exports = { buildStripeTerminalMaintenance, runStripeTerminalMaintenance };
