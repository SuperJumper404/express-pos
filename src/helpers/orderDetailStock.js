const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

const buildOrderDetailStockEntry = ({ productid, qty, operator }) => {
  const timestamp = now();

  return {
    productid,
    category: "1",
    qty,
    operator,
    remark: "Transaction",
    created: timestamp,
    updated: timestamp,
  };
};

module.exports = {
  buildOrderDetailStockEntry,
};
