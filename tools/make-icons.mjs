// Génère les icônes PNG de la PWA sans aucune dépendance : petit rasteriseur
// (4x suréchantillonné) + encodeur PNG basé sur zlib.
// Lancement : node tools/make-icons.mjs
//
// Le dessin est décrit dans un repère de 64 unités, identique au viewBox de
// icons/favicon.svg : les deux doivent rester la même image.
//
//   cadran en haut (l'app est un accordeur) + « BN » en dessous, en monoline
//   à bouts ronds, comme l'aiguille et les graduations de l'interface.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SS = 4; // suréchantillonnage, pour l'anticrénelage
const BG_TOP = [0x16, 0x23, 0x2f];
const BG_BOTTOM = [0x0b, 0x0f, 0x14];
const GREEN = [0x35, 0xd0, 0x7f];
const WHITE = [0xea, 0xf0, 0xf7];
const DIM = [0x3d, 0x4e, 0x63];

// ---------------------------------------------------------------- géométrie
// Un seul endroit décrit la marque : ces constantes servent au rasteriseur
// comme au SVG écrit plus bas.
export const ART = {
  box: 64,
  cornerRadius: 14,
  dial: { cx: 32, cy: 30, r: 17.5, width: 5.2, sweep: 64, greenSweep: 17 },
  // trait à 0,16 de la hauteur de capitale : assez gras pour tenir en 32 px,
  // assez fin pour que les contrepoinçons du B restent des trous.
  letter: { width: 3.6, top: 31.2, bottom: 52.2 },
  b: { x: 18.35, waist: 41.2, upper: { rx: 8.4 }, lower: { rx: 9.2 } },
  n: { left: 34.15, right: 45.65 },
};

/** Points d'un demi-cercle droit (haut -> bas), pour les panses du B. */
function bowl(x, yTop, yBottom, rx) {
  const ey = (yTop + yBottom) / 2;
  const ry = (yBottom - yTop) / 2;
  return Array.from({ length: 15 }, (_, i) => {
    const t = -Math.PI / 2 + (i / 14) * Math.PI;
    return [x + rx * Math.cos(t), ey + ry * Math.sin(t)];
  });
}

/** Points le long d'un arc de cercle, angles comptés depuis la verticale. */
function arc(cx, cy, r, sweep) {
  return Array.from({ length: 33 }, (_, i) => {
    const a = ((-sweep + (i / 32) * 2 * sweep) * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  });
}

/**
 * Les traits de la marque, en unités de 64, dans l'ordre de dessin.
 * Tout est tracé en polyligne à bouts ronds : c'est ce qui fait correspondre
 * pixel pour pixel le rendu de ce fichier et celui de favicon.svg.
 */
function strokes() {
  const { dial: d, letter: L, b, n } = ART;
  return [
    { points: arc(d.cx, d.cy, d.r, d.sweep), color: DIM, width: d.width },
    { points: arc(d.cx, d.cy, d.r, d.greenSweep), color: GREEN, width: d.width },
    { points: [[b.x, L.top], [b.x, L.bottom]], color: WHITE, width: L.width },
    { points: bowl(b.x, L.top, b.waist, b.upper.rx), color: WHITE, width: L.width },
    { points: bowl(b.x, b.waist, L.bottom, b.lower.rx), color: WHITE, width: L.width },
    {
      points: [[n.left, L.bottom], [n.left, L.top], [n.right, L.bottom], [n.right, L.top]],
      color: WHITE,
      width: L.width,
    },
  ];
}

// ------------------------------------------------------------------- PNG
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

// ------------------------------------------------------------- rasteriseur

/**
 * Le point est-il sous le trait ? On sort au premier segment touché, et la
 * boîte englobante écarte d'emblée les pixels loin du tracé : sans ces deux
 * garde-fous, l'arc (32 segments) coûterait dix fois plus cher.
 */
function hitsStroke(x, y, path) {
  const { pts, half, bbox } = path;
  if (x < bbox[0] || x > bbox[2] || y < bbox[1] || y > bbox[3]) return false;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
    const dx = x - (ax + t * vx);
    const dy = y - (ay + t * vy);
    if (dx * dx + dy * dy <= half * half) return true;
  }
  return false;
}

/**
 * Dessine l'icône à la résolution demandée.
 * `inset` réduit le dessin pour la zone de sécurité des icônes « maskable ».
 */
function drawIcon(size, { rounded = true, inset = 0 } = {}) {
  const S = size * SS;
  const px = Buffer.alloc(size * size * 4);
  const k = S / ART.box;            // unités -> pixels
  const sc = 1 - inset;             // réduction centrée du dessin
  const c = ART.box / 2;
  const map = (u) => (c + (u - c) * sc) * k;
  const len = (u) => u * sc * k;
  const radius = rounded ? ART.cornerRadius * k : 0;

  const paths = strokes().map((s) => {
    const pts = s.points.map(([x, y]) => [map(x), map(y)]);
    const half = len(s.width) / 2;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return {
      color: s.color,
      pts,
      half,
      bbox: [Math.min(...xs) - half, Math.min(...ys) - half,
             Math.max(...xs) + half, Math.max(...ys) + half],
    };
  });

  const inRoundRect = (x, y) => {
    if (!rounded) return true;
    const qx = Math.max(radius - x, x - (S - radius), 0);
    const qy = Math.max(radius - y, y - (S - radius), 0);
    return qx * qx + qy * qy <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x * SS + sx + 0.5;
          const fy = y * SS + sy + 0.5;
          if (!inRoundRect(fx, fy)) continue;

          // fond, dégradé vertical
          const t = fy / S;
          let cr = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
          let cg = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
          let cb = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;

          // cadran puis lettres, dans l'ordre de dessin : le dernier trait
          // rencontré recouvre les précédents
          for (const p of paths) {
            if (hitsStroke(fx, fy, p)) [cr, cg, cb] = p.color;
          }

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

// ------------------------------------------------------------------- SVG
// Même marque, en vectoriel : c'est l'icône du navigateur.
function buildSvg() {
  const { dial: d, letter: L, b, n } = ART;
  const rad = (deg) => (deg * Math.PI) / 180;
  const pt = (deg) => [
    (d.cx + d.r * Math.sin(rad(deg))).toFixed(2),
    (d.cy - d.r * Math.cos(rad(deg))).toFixed(2),
  ];
  const arc = (sweep) => {
    const [x0, y0] = pt(-sweep);
    const [x1, y1] = pt(sweep);
    return `M ${x0} ${y0} A ${d.r} ${d.r} 0 0 1 ${x1} ${y1}`;
  };
  const upperRy = ((b.waist - L.top) / 2).toFixed(2);
  const lowerRy = ((L.bottom - b.waist) / 2).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART.box} ${ART.box}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16232f"/>
      <stop offset="1" stop-color="#0b0f14"/>
    </linearGradient>
  </defs>
  <rect width="${ART.box}" height="${ART.box}" rx="${ART.cornerRadius}" fill="url(#bg)"/>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="${arc(d.sweep)}" stroke="#3d4e63" stroke-width="${d.width}"/>
    <path d="${arc(d.greenSweep)}" stroke="#35d07f" stroke-width="${d.width}"/>
    <g stroke="#eaf0f7" stroke-width="${L.width}">
      <path d="M ${b.x} ${L.top} V ${L.bottom}"/>
      <path d="M ${b.x} ${L.top} A ${b.upper.rx} ${upperRy} 0 0 1 ${b.x} ${b.waist}"/>
      <path d="M ${b.x} ${b.waist} A ${b.lower.rx} ${lowerRy} 0 0 1 ${b.x} ${L.bottom}"/>
      <path d="M ${n.left} ${L.bottom} V ${L.top} L ${n.right} ${L.bottom} V ${L.top}"/>
    </g>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------- écriture
mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
const out = (name, buf) => {
  writeFileSync(new URL(`../icons/${name}`, import.meta.url), buf);
  console.log(`${name.padEnd(28)} ${(buf.length / 1024).toFixed(1)} kio`);
};

out('favicon.svg', buildSvg());
out('icon-192.png', drawIcon(192));
out('icon-512.png', drawIcon(512));
out('icon-maskable-512.png', drawIcon(512, { rounded: false, inset: 0.22 }));
out('apple-touch-icon.png', drawIcon(180, { rounded: false }));
