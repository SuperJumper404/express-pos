const multer = require("multer");
const path = require("path");
const { envPUBLICIMAGEPATH } = require("../env");
const { custom, failed } = require("../response");

const limitFile = 3;

const multerStorage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, path.join(envPUBLICIMAGEPATH, "categories"));
  },
  filename: (req, file, callback) => {
    callback(null, `${Date.now()}${path.extname(file.originalname)}`);
  },
});

const multerUploadImg = multer({
  storage: multerStorage,
  limits: {
    fileSize: limitFile * 1024 * 1024,
  },
  fileFilter: (req, file, callback) => {
    const typeExt = path.extname(file.originalname);
    if ([".jpg", ".JPG", ".png", ".PNG", ".jpeg", ".JPEG"].includes(typeExt)) {
      callback(null, true);
    } else {
      callback({ code: "typeExtWrong" }, false);
    }
  },
});

const singleUploadCategoryImg = (req, res, next) => {
  multerUploadImg.single("image")(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return custom(res, 400, `Le fichier dÃ©passe la limite de ${limitFile} Mo.`, {}, null);
    }
    if (error.code === "typeExtWrong") {
      return custom(res, 400, "Type de fichier non autorisÃ©.", {}, null);
    }
    return failed(res, "Erreur serveur.", []);
  });
};

module.exports = singleUploadCategoryImg;
