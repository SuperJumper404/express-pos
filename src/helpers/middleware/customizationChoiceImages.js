const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { envPUBLICIMAGEPATH } = require("../env");
const { custom, failed } = require("../response");

const allowedTypes = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);

const matchesFileSignature = (buffer, mimeType) => {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff;
  }
  if (mimeType === "image/png") {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
  }
  return mimeType === "image/webp"
    && buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
};

const buildCustomizationChoiceImageUpload = ({
  destination = path.join(envPUBLICIMAGEPATH, "customization-choices"),
  fileSystem = fs,
} = {}) => {
  const storage = multer.diskStorage({
    destination: (req, file, callback) => callback(null, destination),
    filename: (req, file, callback) => {
      const extension = allowedTypes.get(file.mimetype);
      const generatedName = `${Date.now()}-${crypto.randomBytes(16).toString("hex")}${extension}`;
      callback(null, generatedName);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, callback) => {
      if (allowedTypes.has(file.mimetype)) return callback(null, true);
      const error = new Error("Type de fichier non autorisé.");
      error.code = "INVALID_FILE_TYPE";
      return callback(error, false);
    },
  });

  const removeUploadedFile = (file) => {
    if (!file) return;
    try {
      if (fileSystem.existsSync(file.path)) fileSystem.unlinkSync(file.path);
    } catch (error) {
      console.error("Invalid customization image cleanup failed:", error.message);
    }
  };

  return (req, res, next) => {
    upload.single("image")(req, res, (error) => {
      if (error) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return custom(res, 400, "Le fichier dépasse la limite de 5 Mo.", null, null);
        }
        if (error.code === "INVALID_FILE_TYPE") {
          return custom(res, 400, "Type de fichier non autorisé.", null, null);
        }
        return failed(res, "Erreur serveur.", error.message);
      }
      if (!req.file) return next();

      let descriptor;
      try {
        descriptor = fileSystem.openSync(req.file.path, "r");
        const signature = Buffer.alloc(12);
        const bytesRead = fileSystem.readSync(descriptor, signature, 0, signature.length, 0);
        if (!matchesFileSignature(signature.subarray(0, bytesRead), req.file.mimetype)) {
          fileSystem.closeSync(descriptor);
          descriptor = null;
          removeUploadedFile(req.file);
          req.file = undefined;
          return custom(res, 400, "Type de fichier non autorisé.", null, null);
        }
        fileSystem.closeSync(descriptor);
        return next();
      } catch (signatureError) {
        if (descriptor != null) {
          try {
            fileSystem.closeSync(descriptor);
          } catch (closeError) {
            console.error("Customization image close failed:", closeError.message);
          }
        }
        removeUploadedFile(req.file);
        req.file = undefined;
        return failed(res, "Erreur serveur.", signatureError.message);
      }
    });
  };
};

const customizationChoiceImageUpload = buildCustomizationChoiceImageUpload();

module.exports = customizationChoiceImageUpload;
module.exports.buildCustomizationChoiceImageUpload = buildCustomizationChoiceImageUpload;
