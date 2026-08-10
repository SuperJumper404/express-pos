const assert = require("assert");
const { ORDER_STATUSES } = require("../src/helpers/orderStatus");
const {
  buildOrderTransitionModule,
} = require("../src/modules/m_orderTransitions");

const run = async () => {
  const updates = [];
  const transitions = buildOrderTransitionModule({
    withTransaction: async (work) => work({ transaction: true }),
    repository: {
      lockOrder: async () => ({
        id: 42,
        shopid: 7,
        status: ORDER_STATUSES.PENDING,
      }),
      findUserById: async () => ({
        id: 11,
        shopid: 7,
        username: "Leo",
        access: 5,
      }),
      updateStatus: async (input) => {
        updates.push(input);
        return { affectedRows: 1 };
      },
    },
  });

  await transitions.transitionOrderStatus({
    orderId: 42,
    shopId: 7,
    operator: 11,
    nextStatus: ORDER_STATUSES.PREPARING,
  });

  assert.deepStrictEqual(updates[0].preparedBy, {
    id: 11,
    name: "Leo",
  });
  console.log("order attribution transition tests passed");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
