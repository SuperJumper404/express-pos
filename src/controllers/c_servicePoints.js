const { custom, failed, success } = require("../helpers/response");

const parseServicePointId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const normalizeName = (value) => String(value || "").trim();
const isEditableTable = (point) =>
  point && point.type === "table" && Number(point.is_system) !== 1;

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
      return success(res, "Tables recuperees.", null, points);
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
  };
};

module.exports = {
  buildServicePointsController,
  ...buildServicePointsController(),
};
