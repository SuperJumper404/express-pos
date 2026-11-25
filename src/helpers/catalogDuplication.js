const path = require("node:path");
const { constants } = require("node:fs");
const { randomUUID } = require("node:crypto");

const copyName = (name) => `${Array.from(name).slice(0, 247).join("")} (copie)`;

const createImageCopy = ({ fileSystem, resolveImagePath, removeImage }) => {
  const copies = [];
  return {
    copy(filename) {
      const source = resolveImagePath(filename);
      if (!source || !fileSystem.existsSync(source)) return null;
      const copy = `copy-${randomUUID()}${path.extname(filename)}`;
      fileSystem.copyFileSync(source, resolveImagePath(copy), constants.COPYFILE_EXCL);
      copies.push(copy);
      return copy;
    },
    discard() {
      copies.forEach(removeImage);
    },
  };
};

module.exports = { copyName, createImageCopy };
