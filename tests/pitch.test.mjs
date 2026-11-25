// Vérifie le détecteur sur des signaux synthétiques imitant une corde de
// guitare (partiels décroissants, fondamental parfois très faible, bruit,
// enveloppe qui décroît). Lancement : node tests/pitch.test.mjs
import { createDetector, smoothFrequencies } from '../js/pitch.js';
import { centsBetween } from '../js/notes.js';

const SR = 44100;
const N = 4096;

function mulberry(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

function pluck(freq, { harmonics = [1, 0.6, 0.4, 0.25, 0.15, 0.1], noise = 0, decay = 0, phase = 0.3, seed = 7 } = {}) {
  const rnd = mulberry(seed);
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let v = 0;
    harmonics.forEach((amp, k) => {
      v += amp * Math.sin(2 * Math.PI * freq * (k + 1) * t + phase * (k + 1));
    });
    const gain = harmonics.reduce((a, b) => a + b, 0);
    if (gain > 0) v /= gain;
    if (decay) v *= Math.exp(-decay * t);
    if (noise) v += noise * rnd();
    buf[i] = v * 0.5;
  }
  return buf;
}

const detector = createDetector({ sampleRate: SR, bufferSize: N });
let failures = 0;

function check(label, buffer, expected, maxCents) {
  const { freq, clarity } = detector.detect(buffer);
  const cents = freq ? centsBetween(freq, expected) : NaN;
  const ok = freq > 0 && Math.abs(cents) <= maxCents;
  if (!ok) failures++;
  const detail = freq
    ? `${freq.toFixed(2)} Hz (${cents >= 0 ? '+' : ''}${cents.toFixed(2)} cents, clarté ${clarity.toFixed(2)})`
    : 'aucune détection';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${detail}`);
}

// Les six cordes à vide en accordage standard (La = 440 Hz).
const OPEN = [
  ['E2 (mi grave)', 82.41],
  ['A2 (la)', 110.0],
  ['D3 (ré)', 146.83],
  ['G3 (sol)', 196.0],
  ['B3 (si)', 246.94],
  ['E4 (mi aigu)', 329.63],
];

console.log('— cordes à vide, timbre riche —');
for (const [name, f] of OPEN) check(name, pluck(f), f, 1);

console.log('\n— fondamental très faible (micro de téléphone) —');
const weak = { harmonics: [0.08, 0.7, 0.5, 0.35, 0.2] };
for (const [name, f] of OPEN.slice(0, 3)) check(name, pluck(f, weak), f, 2);

console.log('\n— désaccordé, bruit de fond et décroissance —');
for (const [name, f] of OPEN) {
  const detuned = f * Math.pow(2, -37 / 1200); // 37 cents trop bas
  check(name, pluck(detuned, { noise: 0.06, decay: 2.2, seed: 42 }), detuned, 4);
}

// Les cordes filées sont raides : leurs partiels tombent à k*f0*sqrt(1+B k^2)
// et non sur des multiples exacts. C'est la cause classique des désaccords
// entre accordeurs — on vérifie que le biais reste négligeable.
function stiff(freq, B) {
  const buf = new Float32Array(N);
  const amps = [1, 0.6, 0.42, 0.3, 0.22, 0.16, 0.12];
  const gain = amps.reduce((a, b) => a + b, 0);
  for (let i = 0; i < N; i++) {
    let v = 0;
    amps.forEach((a, k) => {
      const fk = (k + 1) * freq * Math.sqrt(1 + B * (k + 1) ** 2);
      v += a * Math.sin((2 * Math.PI * fk * i) / SR + 0.3 * k);
    });
    buf[i] = (v / gain) * 0.5;
  }
  return buf;
}

console.log('\n— inharmonicité des cordes filées (B = 5e-5, puis 1e-4) —');
for (const [name, f] of OPEN) check(`${name}, B = 5e-5`, stiff(f, 5e-5), f, 3);
for (const [name, f] of OPEN.slice(0, 3)) check(`${name}, B = 1e-4`, stiff(f, 1e-4), f, 3);

// iOS fait tourner l'audio à 48 kHz : la plage de retards change, donc on
// vérifie le détecteur à cette fréquence aussi.
console.log('\n— à 48 kHz (la fréquence réelle sur iOS) —');
{
  const SR48 = 48000;
  const det48 = createDetector({ sampleRate: SR48, bufferSize: N });
  for (const [name, f] of OPEN) {
    const buf = new Float32Array(N);
    const harm = [1, 0.6, 0.4, 0.25, 0.15, 0.1];
    const gain = harm.reduce((a, b) => a + b, 0);
    for (let i = 0; i < N; i++) {
      let v = 0;
      harm.forEach((a, k) => { v += a * Math.sin((2 * Math.PI * f * (k + 1) * i) / SR48 + 0.3 * (k + 1)); });
      buf[i] = (v / gain) * 0.5;
    }
    const { freq, clarity } = det48.detect(buf);
    const cents = freq ? centsBetween(freq, f) : NaN;
    const ok = freq > 0 && Math.abs(cents) <= 1;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${freq ? `${freq.toFixed(2)} Hz (${cents >= 0 ? '+' : ''}${cents.toFixed(2)} cents, clarté ${clarity.toFixed(2)})` : 'aucune détection'}`);
  }
}

console.log('\n— cas limites —');
const silence = new Float32Array(N);
const s = detector.detect(silence);
const okSilence = s.freq === 0;
if (!okSilence) failures++;
console.log(`${okSilence ? 'ok  ' : 'FAIL'} silence -> aucune détection`);

const hiss = pluck(0, { harmonics: [0], noise: 1, seed: 3 });
const h = detector.detect(hiss);
const okHiss = h.freq === 0 || h.clarity < 0.7;
if (!okHiss) failures++;
console.log(`${okHiss ? 'ok  ' : 'FAIL'} bruit blanc -> pas de note nette (clarté ${h.clarity.toFixed(2)})`);

const med = smoothFrequencies([82.4, 82.5, 164.9, 82.3, 82.45]);
const okMed = Math.abs(med - 82.41) < 0.3;
if (!okMed) failures++;
console.log(`${okMed ? 'ok  ' : 'FAIL'} lissage : saut d'octave isolé écarté (${med.toFixed(2)} Hz)`);

console.log(`\n${failures === 0 ? 'Tous les tests passent.' : failures + ' test(s) en échec.'}`);
process.exit(failures === 0 ? 0 : 1);
