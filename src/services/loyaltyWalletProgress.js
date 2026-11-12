const { PNG } = require('pngjs');
const DomainError = require('../helpers/domainError');
const { validateWalletPng } = require('./loyaltyWalletAssets');
const invalid = () => new DomainError(503, 'WALLET_ASSETS_INVALID', 'Wallet artwork is unavailable');

function renderWalletProgress({ images = {}, progress, backgroundColor = '#173A32' }) {
  if (!progress) return {};
  if (!Number.isFinite(progress.ratio) || progress.ratio < 0 || progress.ratio > 1) throw invalid();
  const color = /^#[a-f0-9]{6}$/i.test(backgroundColor) ? backgroundColor : '#173A32';
  const background = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
  const decoded = new Map();
  const decode = bytes => {
    if (decoded.has(bytes)) return decoded.get(bytes);
    if (!Buffer.isBuffer(bytes) || bytes.length < 33 || bytes.length > 2 * 1024 * 1024) throw invalid();
    const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
    if (!width || !height || width > 1125 || height > 432) throw invalid();
    // Check CRCs and bound the inflated pixel rows before pngjs allocates/decodes.
    try { validateWalletPng(bytes, { width, height }); } catch (_) { throw invalid(); }
    const image = PNG.sync.read(bytes, { checkCRC: true });
    decoded.set(bytes, image); return image;
  };
  const fallback = images['strip@3x.png'] || images['strip@2x.png'] || images['strip.png'];
  const output = {};
  for (const scale of [1, 2, 3]) {
    const name = `strip${scale === 1 ? '' : `@${scale}x`}.png`;
    const bytes = images[name] || fallback;
    const source = bytes ? decode(bytes) : null;
    const width = 375 * scale; const height = 144 * scale;
    const data = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (source) {
        const sourceOffset = (Math.floor(y * source.height / height) * source.width + Math.floor(x * source.width / width)) * 4;
        source.data.copy(data, offset, sourceOffset, sourceOffset + 4);
      } else { data[offset] = background[0]; data[offset + 1] = background[1]; data[offset + 2] = background[2]; data[offset + 3] = 255; }
    }
    const blend = (x, y, rgb, opacity) => {
      const offset = (y * width + x) * 4; const alpha = data[offset + 3] / 255;
      const combined = opacity + alpha * (1 - opacity);
      for (let channel = 0; channel < 3; channel++) data[offset + channel] = Math.round((rgb[channel] * opacity + data[offset + channel] * alpha * (1 - opacity)) / combined);
      data[offset + 3] = Math.round(combined * 255);
    };
    // The translucent footer guarantees bar contrast, including on bright/transparent artwork.
    for (let y = height - 32 * scale; y < height; y++) for (let x = 0; x < width; x++) blend(x, y, [0, 0, 0], 0.68);
    const pill = (length, opacity) => {
      if (!length) return;
      const left = 16 * scale; const top = height - 18 * scale; const bottom = top + 6 * scale;
      const right = left + length; const radius = Math.min(3 * scale, length / 2);
      for (let y = Math.floor(top); y < Math.ceil(bottom); y++) for (let x = Math.floor(left); x < Math.ceil(right); x++) {
        let covered = 0;
        for (const dx of [0.25, 0.75]) for (const dy of [0.25, 0.75]) {
          const px = x + dx; const py = y + dy;
          if (px < left || px > right || py < top || py > bottom) continue;
          const cx = Math.max(left + radius, Math.min(px, right - radius));
          const cy = Math.max(top + radius, Math.min(py, bottom - radius));
          if ((px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2) covered++;
        }
        if (covered) blend(x, y, [255, 255, 255], opacity * covered / 4);
      }
    };
    const trackWidth = width - 32 * scale;
    pill(trackWidth, 0.22); pill(trackWidth * progress.ratio, 1);
    output[name] = PNG.sync.write({ width, height, data }, { colorType: 6, inputColorType: 6 });
  }
  return output;
}

module.exports = { renderWalletProgress };
