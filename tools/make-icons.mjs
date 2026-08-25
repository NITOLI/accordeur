// Génère les icônes PNG de la PWA sans aucune dépendance : petit rasteriseur
// (4x suréchantillonné) + encodeur PNG basé sur zlib.
// Lancement : node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SS = 4; // suréchantillonnage
const BG_TOP = [0x16, 0x23, 0x2f];
const BG_BOTTOM = [0x0b, 0x0f, 0x14];
const GREEN = [0x35, 0xd0, 0x7f];
const WHITE = [0xea, 0xf0, 0xf7];
const DIM = [0x2a, 0x36, 0x46];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filtre "none"
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // profondeur
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Dessine l'icône à la résolution demandée. `inset` = marge pour le maskable. */
function drawIcon(size, { rounded = true, inset = 0 } = {}) {
  const S = size * SS;
  const px = Buffer.alloc(size * size * 4);
  const radius = rounded ? 0.22 * S : 0;
  const cx = S / 2;
  const cy = S * 0.70;
  const scale = 1 - inset;
  const arcR = 0.355 * S * scale;
  const arcT = 0.058 * S * scale;
  const needleLen = 0.335 * S * scale;
  const needleT = 0.042 * S * scale;
  const needleAngle = -14 * (Math.PI / 180);
  const nx = cx + needleLen * Math.sin(needleAngle);
  const ny = cy - needleLen * Math.cos(needleAngle);
  const hubR = 0.035 * S * scale;

  const inRoundRect = (x, y) => {
    if (!rounded) return true;
    const qx = Math.max(radius - x, x - (S - radius), 0);
    const qy = Math.max(radius - y, y - (S - radius), 0);
    return qx * qx + qy * qy <= radius * radius;
  };

  const segDist = (x, y) => {
    const vx = nx - cx;
    const vy = ny - cy;
    const t = Math.max(0, Math.min(1, ((x - cx) * vx + (y - cy) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(x - (cx + t * vx), y - (cy + t * vy));
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px4 = x * SS + sx + 0.5;
          const py4 = y * SS + sy + 0.5;
          if (!inRoundRect(px4, py4)) continue;

          // Fond dégradé vertical.
          const k = py4 / S;
          let cr = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * k;
          let cg = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * k;
          let cb = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * k;

          const dx = px4 - cx;
          const dy = py4 - cy;
          const dist = Math.hypot(dx, dy);
          const ang = Math.atan2(dx, -dy) * (180 / Math.PI);

          // Cadran : gris sur les bords, vert autour du zéro.
          if (Math.abs(dist - arcR) <= arcT / 2 && Math.abs(ang) <= 62) {
            const c = Math.abs(ang) <= 16 ? GREEN : DIM;
            [cr, cg, cb] = c;
          }
          // Aiguille + moyeu.
          if (segDist(px4, py4) <= needleT / 2 || dist <= hubR) [cr, cg, cb] = WHITE;

          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      const cov = a / (255 * n);
      px[i] = cov ? Math.round(r / (n * cov)) : 0;
      px[i + 1] = cov ? Math.round(g / (n * cov)) : 0;
      px[i + 2] = cov ? Math.round(b / (n * cov)) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, size, px);
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
const out = (name, buf) => {
  writeFileSync(new URL(`../icons/${name}`, import.meta.url), buf);
  console.log(`${name} — ${(buf.length / 1024).toFixed(1)} kio`);
};

out('icon-192.png', drawIcon(192));
out('icon-512.png', drawIcon(512));
out('icon-maskable-512.png', drawIcon(512, { rounded: false, inset: 0.22 }));
out('apple-touch-icon.png', drawIcon(180, { rounded: false }));
