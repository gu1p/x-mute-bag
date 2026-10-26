// Reproducible vector-shaped icons, rasterized with supersampling. No dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const type = Buffer.from(name), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([len, type, bytes, crc]);
}
function pixel(x, y) {
  const corner = Math.hypot(Math.max(0, Math.abs(x - 64) - 39), Math.max(0, Math.abs(y - 64) - 39));
  if (corner > 22) return [0, 0, 0, 0];
  let color = [21, 35, 31, 255];
  const handle = Math.hypot(x - 64, y - 44);
  const bag = y >= 44 && y <= 98 && x >= 33 - (y - 44) * .075 && x <= 95 + (y - 44) * .075;
  if (bag || (y < 46 && handle >= 17 && handle <= 24)) color = [184, 244, 218, 255];
  if (x >= 47 && x <= 81 && y >= 67 && y <= 75) color = [21, 35, 31, 255];
  return color;
}
const root = path.join(__dirname, '..', 'icons');
fs.mkdirSync(root, {recursive: true});
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const avg = [0, 0, 0, 0];
    for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
      const p = pixel((x + (dx + .5) / 4) * 128 / size, (y + (dy + .5) / 4) * 128 / size);
      for (let c = 0; c < 4; c++) avg[c] += p[c] / 16;
    }
    for (let c = 0; c < 4; c++) raw[y * (1 + size * 4) + 1 + x * 4 + c] = Math.round(avg[c]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(path.join(root, 'icon' + size + '.png'), Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}
