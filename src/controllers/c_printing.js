const { mGetShopInfo } = require("../modules/m_shop");
const { mDetailArchivedOrder } = require("../modules/m_orders");
const { success, failed } = require("../helpers/response");
const NodeCache = require("node-cache");

/* -------------------------------------------------------------------------- */
/*     // ! ICI ON A PAS DE MODULE PRINTING, ON FAIT DU CACHE EN MEMOIRE !    */
/* -------------------------------------------------------------------------- */
/**
 * il y'a 3 types de tickets : 'caisse', 'commande', 'all'
 */
const printingCache = new NodeCache({
  stdTTL: 60,
  checkperiod: 60,
  maxKeys: 1000,
});

function setMultiple(key, value) {
  let values = printingCache.get(key) || [];
  values.push(value);
  printingCache.set(key, values);
}
function getAndPopOldest(key, ticketType) {
  const values = printingCache.get(key);
  // console.log(
  //   " JOB TO POP key =",
  //   key,
  //   " ticketType =",
  //   ticketType,
  //   " values =",
  //   values,
  // );
  if (!Array.isArray(values) || values.length === 0) return undefined;

  // CAS SPÉCIAL : ALL → on prend le plus ancien
  if (ticketType === "all") {
    const item = values.shift(); // FIFO
    printingCache.set(key, values);
    return item;
  }

  // Sinon : dernier job correspondant au ticketType
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i].ticketType === ticketType) {
      const [item] = values.splice(i, 1);
      printingCache.set(key, values);
      return item;
    }
  }

  return undefined;
}

exports.addPrintingJob = async (req, res) => {
  try {
    const shopId = req.shopid;
    const xml = req.body?.requete;
    const shopInfo = await mGetShopInfo(shopId);
    console.log("ShopInfo =", shopInfo);
    const orderId = req.body?.orderId;
    const ticketType = req.body?.ticketType;
    console.log("TicketType =", ticketType);
    console.log("OrderId =", orderId);
    // if (orderId) {
    //   const orderDetails = await mDetailArchivedOrder(orderId);
    //   console.log("OrderDetails =", orderDetails);
    // }
    console.log("AddPrintingJob for shopId =", shopId, " XML =", xml);
    if (!xml) {
      return failed(res, "Données d'impression manquantes.", "Missing XML in request.", 400);
    }
    setMultiple(shopId, { shopId, ticketType, xml });
    return success(res, "Travail d'impression ajouté.", null, { ticketType });
  } catch (err) {
    console.error("Error addPrintingJob", err);
    return failed(res, "Erreur inattendue pendant l'impression.", err.message);
  }
};

exports.getPrintingJob = async (req, res) => {
  try {
    // Printer sent data?
    const params = new URLSearchParams(req.body);
    console.log("Params =", params.toString());
    const shopId = params.get("ID");
    const ticketType = params.get("Name");

    if (shopId) {
      let printJob = getAndPopOldest(shopId, ticketType);
      if (printJob) {
        res.send(printJob.xml);
        return;
      }
      return success(res, "Aucun travail d'impression disponible.", null, { job: null });
    } else {
      return failed(res, "Identifiant boutique manquant.", "Missing shop ID", 400);
    }
  } catch (err) {
    console.error("Error getPrintingJob", err);
    return failed(res, "Erreur inattendue pendant la récupération d'impression.", err.message);
  }
};
