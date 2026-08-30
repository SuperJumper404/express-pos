const { custom, failed, success } = require("../helpers/response");
const {
  createStaffLoginId: createKioskLoginId,
  createStaffPin: createKioskPin,
  hashStaffPin,
} = require("../helpers/staffCredentials");
const {
  signServicePointAccessToken,
  signServicePointSessionToken,
  verifyServicePointAccessToken,
} = require("../helpers/servicePointAccessToken");

const parseServicePointId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const normalizeName = (value) => String(value || "").trim();
const isEditableTable = (point) =>
  point && point.type === "table" && Number(point.is_system) !== 1;
const isEditableKiosk = (point) =>
  point && point.type === "kiosk" && Number(point.is_system) !== 1;

const buildServicePointsController = (repository) => {
  const getRepository = () => repository || require("../modules/m_servicePoints");

  return {
  listPoints: async (req, res) => {
    try {
      const points = await getRepository().listServicePoints({
        shopId: req.shopid,
        activeOnly: true,
      });
      return success(res, "Points de service recuperes.", null, points);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  listTables: async (req, res) => {
    try {
      const points = await getRepository().listServicePoints({
        shopId: req.shopid,
        activeOnly: false,
        tablesOnly: true,
      });
      return success(
        res,
        "Tables recuperees.",
        null,
        points.map((point) => ({
          ...point,
          table_access_token: signServicePointAccessToken({
            servicePointId: point.id,
            shopId: point.shopid,
            source: "table_qr",
            version: point.public_access_version,
          }),
        })),
      );
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  listKiosks: async (req, res) => {
    try {
      const points = await getRepository().listServicePoints({
        shopId: req.shopid,
        activeOnly: false,
        kiosksOnly: true,
      });
      return success(res, "Bornes recuperees.", null, points);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  createTable: async (req, res) => {
    const name = normalizeName(req.body && req.body.name);
    if (!name) {
      return custom(res, 422, "Le nom de la table est requis.", null, null);
    }

    try {
      const data = {
        shopId: req.shopid,
        name,
        type: "table",
      };
      const created = await getRepository().createTablePoint(data);
      return custom(res, 201, "Table creee avec succes.", null, created);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  createKiosk: async (req, res) => {
    const name = normalizeName(req.body && req.body.name);
    if (!name) {
      return custom(res, 422, "Le nom de la borne est requis.", null, null);
    }

    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const kioskLoginId = createKioskLoginId();
        const kioskPin = createKioskPin();
        try {
          const created = await getRepository().createKioskPoint({
            shopId: req.shopid,
            name,
            kioskLoginId,
            kioskPin,
            kioskPinHash: await hashStaffPin(kioskPin),
          });
          return custom(res, 201, "Borne creee avec succes.", null, {
            id: created.insertId,
            kiosk_login_id: kioskLoginId,
            kiosk_pin: kioskPin,
          });
        } catch (error) {
          if (!(error.code === "ER_DUP_ENTRY" && attempt < 4)) throw error;
        }
      }
      return failed(res, "Erreur serveur.", "Impossible de generer un ID unique.");
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  updateTable: async (req, res) => {
    const servicePointId = parseServicePointId(req.params.id);
    if (!servicePointId) {
      return custom(res, 422, "Table invalide.", null, null);
    }

    try {
      const point = await getRepository().findServicePoint({
        servicePointId,
        shopId: req.shopid,
      });
      if (!isEditableTable(point)) {
        return custom(res, 422, "Seules les tables peuvent etre modifiees.", null, null);
      }

      const body = req.body || {};
      const hasName = Object.prototype.hasOwnProperty.call(body, "name");
      const hasActive = Object.prototype.hasOwnProperty.call(body, "is_active");
      const name = hasName ? normalizeName(body.name) : undefined;
      if ((hasName && !name) || (!hasName && !hasActive)) {
        return custom(res, 422, "Modification de table invalide.", null, null);
      }

      const result = await getRepository().updateTablePoint({
        servicePointId,
        shopId: req.shopid,
        name,
        isActive: hasActive ? (Number(body.is_active) ? 1 : 0) : undefined,
      });
      if (!result.affectedRows) {
        return custom(res, 404, "Table introuvable.", null, null);
      }
      return success(res, "Table mise a jour.", null, null);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  reorderTables: async (req, res) => {
    try {
      await getRepository().reorderTablePoints({
        shopId: req.shopid,
        ids: req.body && req.body.ids,
      });
      return success(res, "Ordre des tables mis a jour.", null, null);
    } catch (error) {
      return custom(res, 422, "Ordre des tables invalide.", null, null);
    }
  },

  updateKiosk: async (req, res) => {
    const servicePointId = parseServicePointId(req.params.id);
    if (!servicePointId) {
      return custom(res, 422, "Borne invalide.", null, null);
    }

    try {
      const point = await getRepository().findServicePoint({
        servicePointId,
        shopId: req.shopid,
      });
      if (!isEditableKiosk(point)) {
        return custom(res, 422, "Seules les bornes peuvent etre modifiees.", null, null);
      }

      const body = req.body || {};
      const hasName = Object.prototype.hasOwnProperty.call(body, "name");
      const hasActive = Object.prototype.hasOwnProperty.call(body, "is_active");
      const name = hasName ? normalizeName(body.name) : undefined;
      if ((hasName && !name) || (!hasName && !hasActive)) {
        return custom(res, 422, "Modification de borne invalide.", null, null);
      }

      const result = await getRepository().updateKioskPoint({
        servicePointId,
        shopId: req.shopid,
        name,
        isActive: hasActive ? (Number(body.is_active) ? 1 : 0) : undefined,
      });
      if (!result.affectedRows) {
        return custom(res, 404, "Borne introuvable.", null, null);
      }
      return success(res, "Borne mise a jour.", null, null);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  regenerateKioskCredentials: async (req, res) => {
    const servicePointId = parseServicePointId(req.params.id);
    if (!servicePointId) {
      return custom(res, 422, "Borne invalide.", null, null);
    }

    try {
      const point = await getRepository().findServicePoint({
        servicePointId,
        shopId: req.shopid,
      });
      if (!isEditableKiosk(point)) {
        return custom(res, 422, "Seules les bornes peuvent etre modifiees.", null, null);
      }

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const kioskLoginId = point.kiosk_login_id || createKioskLoginId();
        const kioskPin = createKioskPin();
        try {
          await getRepository().updateKioskCredentials({
            servicePointId,
            shopId: req.shopid,
            kioskLoginId,
            kioskPin,
            kioskPinHash: await hashStaffPin(kioskPin),
          });
          return success(res, "PIN borne regenere.", null, {
            kiosk_login_id: kioskLoginId,
            kiosk_pin: kioskPin,
          });
        } catch (error) {
          if (!(error.code === "ER_DUP_ENTRY" && attempt < 4)) throw error;
        }
      }
      return failed(res, "Erreur serveur.", "Impossible de generer un ID unique.");
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  deleteTable: async (req, res) => {
    const servicePointId = parseServicePointId(req.params.id);
    if (!servicePointId) {
      return custom(res, 422, "Table invalide.", null, null);
    }

    try {
      const point = await getRepository().findServicePoint({
        servicePointId,
        shopId: req.shopid,
      });
      if (!isEditableTable(point)) {
        return custom(res, 422, "Seules les tables peuvent etre supprimees.", null, null);
      }

      const result = await getRepository().deleteTablePoint({
        servicePointId,
        shopId: req.shopid,
      });
      if (!result.affectedRows) {
        return custom(res, 404, "Table introuvable.", null, null);
      }
      return success(res, "Table supprimee.", null, null);
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },

  createTableAccessSession: async (req, res) => {
    try {
      const token = req.body && req.body.token;
      if (!token) {
        return custom(res, 422, "Token QR requis.", null, null);
      }

      const access = verifyServicePointAccessToken(token);
      if (access.source !== "table_qr") {
        return custom(res, 401, "Token QR invalide.", null, null);
      }

      const point = await getRepository().findServicePoint({
        servicePointId: access.servicePointId,
        shopId: access.shopId,
      });
      if (
        !point ||
        point.type !== "table" ||
        Number(point.is_active) !== 1 ||
        Number(point.public_access_version) !== access.version
      ) {
        return custom(res, 401, "Token QR invalide.", null, null);
      }

      const sessionToken = signServicePointSessionToken({
        servicePointId: point.id,
        shopId: point.shopid,
        source: "table_qr",
      });
      return success(res, "Connexion table reussie.", null, {
        session_subject: "service_point",
        service_point_id: point.id,
        shopid: point.shopid,
        username: point.name,
        access: 2,
        source: "table_qr",
        token: sessionToken,
      });
    } catch (error) {
      return custom(res, 401, error.message || "Token QR invalide.", null, null);
    }
  },

  createClickAndCollectSession: async (req, res) => {
    const shopId = parseServicePointId(req.params.shopid);
    if (!shopId) {
      return custom(res, 422, "Boutique invalide.", null, null);
    }

    try {
      const point = await getRepository().findSystemPoint({
        shopId,
        systemKey: "click_collect",
      });
      if (
        !point ||
        point.type !== "click_collect" ||
        Number(point.is_active) !== 1
      ) {
        return custom(res, 404, "Click & Collect indisponible.", null, null);
      }

      const sessionToken = signServicePointSessionToken({
        servicePointId: point.id,
        shopId: point.shopid,
        source: "web",
      });
      return success(res, "Session Click & Collect creee.", null, {
        session_subject: "service_point",
        service_point_id: point.id,
        shopid: point.shopid,
        username: point.name,
        access: 2,
        source: "web",
        token: sessionToken,
      });
    } catch (error) {
      return failed(res, "Erreur serveur.", error.message);
    }
  },
  };
};

module.exports = {
  buildServicePointsController,
  ...buildServicePointsController(),
};
