// Generates PNG app icons without any image dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return [f(0), f(8), f(4)];
};

// 3x3 bricks in cyan→magenta→orange, a glowing ball and its dotted path.
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const bricks = [];
  const hues = [190, 255, 315, 215, 285, 15, 255, 340, 35];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    if (r === 2 && c === 1) continue; // gap the ball flies through
    bricks.push({ x: 0.17 + c * 0.23, y: 0.14 + r * 0.17, w: 0.2, h: 0.14, hue: hues[r * 3 + c] });
  }
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let [r, g, b] = [10 + 22 * v, 6 + 6 * v, 36 + 30 * v];
      for (const k of bricks) {
        const dx = Math.max(k.x - u, 0, u - (k.x + k.w)), dy = Math.max(k.y - v, 0, v - (k.y + k.h));
        const d = Math.hypot(dx, dy);
        const [cr, cg, cb] = hsl(k.hue, 0.95, 0.58 - (v - k.y) * 0.9);
        if (d === 0) { r = cr; g = cg; b = cb; }
        else if (d < 0.05) { const a = (1 - d / 0.05) ** 2 * 0.5; r += cr * a; g += cg * a; b += cb * a; }
      }
      // dotted aim path
      for (let i = 0; i < 4; i++) {
        const px = 0.5 - i * 0.02, py = 0.86 - i * 0.075;
        if (Math.hypot(u - px, v - py) < 0.016) { r = 160; g = 235; b = 255; }
      }
      const bd = Math.hypot(u - 0.5, v - 0.86);
      if (bd < 0.045) { r = 255; g = 255; b = 255; }
      else if (bd < 0.14) { const a = (1 - bd / 0.14) ** 2; r += 80 * a; g += 200 * a; b += 255 * a; }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = Math.min(255, r); raw[o + 1] = Math.min(255, g); raw[o + 2] = Math.min(255, b); raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const s of [180, 192, 512]) writeFileSync(`public/icon-${s}.png`, icon(s));
console.log('icons written');
