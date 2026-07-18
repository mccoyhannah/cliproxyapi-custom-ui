import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const SCALE = SIZE / 64;
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetsDirectory = path.join(path.dirname(scriptsDirectory), 'assets');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function blend(base, overlay, opacity) {
  return Math.round(base * (1 - opacity) + overlay * opacity);
}

function createRgbaImage() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const center = (SIZE - 1) / 2;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const radius = Math.hypot(dx, dy);
      const index = (y * SIZE + x) * 4;

      let red = 9;
      let green = 18;
      let blue = 23;
      let alpha =
        radius <= 30 * SCALE ? 255 : Math.max(0, Math.round((31 * SCALE - radius) * (255 / SCALE)));

      if (radius <= 28 * SCALE) {
        const glow = Math.max(0, 1 - radius / (28 * SCALE));
        red = blend(red, 18, glow * 0.5);
        green = blend(green, 48, glow * 0.45);
        blue = blend(blue, 52, glow * 0.5);
      }

      const angle = Math.atan2(dy, dx);
      const isGaugeArc =
        radius >= 23 * SCALE && radius <= 27 * SCALE && angle >= -2.45 && angle <= 2.45;
      if (isGaugeArc) {
        const progress = (angle + 2.45) / 4.9;
        red = blend(41, 247, Math.max(0, (progress - 0.76) / 0.24));
        green = blend(220, 179, Math.max(0, (progress - 0.76) / 0.24));
        blue = blend(190, 82, Math.max(0, (progress - 0.76) / 0.24));
      }

      const pulseY = 34 * SCALE - Math.sin((x / SCALE - 12) * 0.28) * 3 * SCALE;
      if (
        x >= 13 * SCALE &&
        x <= 51 * SCALE &&
        Math.abs(y - pulseY) < 1.2 * SCALE &&
        radius < 21 * SCALE
      ) {
        red = 57;
        green = 232;
        blue = 202;
      }

      pixels[index] = red;
      pixels[index + 1] = green;
      pixels[index + 2] = blue;
      pixels[index + 3] = alpha;
    }
  }

  return pixels;
}

function createPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;

  const rgba = createRgbaImage();
  const scanlines = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const rowOffset = y * (SIZE * 4 + 1);
    scanlines[rowOffset] = 0;
    rgba.copy(scanlines, rowOffset + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = SIZE === 256 ? 0 : SIZE;
  entry[1] = SIZE === 256 ? 0 : SIZE;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

await mkdir(assetsDirectory, { recursive: true });
const png = createPng();
await Promise.all([
  writeFile(path.join(assetsDirectory, 'icon.png'), png),
  writeFile(path.join(assetsDirectory, 'icon.ico'), createIco(png)),
]);
