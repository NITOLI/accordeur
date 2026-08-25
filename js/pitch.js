// Détection de hauteur par la méthode McLeod (MPM) : fonction de différence
// normalisée (NSDF) + choix du premier pic significatif + interpolation
// parabolique. Robuste sur les cordes graves, où le fondamental est faible.
// Module pur : aucune dépendance au DOM, donc testable sous Node.

const DEFAULTS = {
  minFreq: 60,      // en dessous du si grave d'une basse accordée bas
  maxFreq: 1200,    // au-dessus du mi aigu joué à la 12e case
  clarityMin: 0.5,  // seuil de périodicité sous lequel on ignore la trame
  peakRatio: 0.86,  // "k" de MPM : tolérance sur le premier pic retenu
  rmsMin: 0.006,    // seuil de niveau : en dessous, on considère le silence
};

/**
 * Crée un détecteur réutilisable (les tampons sont alloués une seule fois).
 * @param {{sampleRate:number, bufferSize:number}} opts
 */
export function createDetector(opts) {
  const cfg = { ...DEFAULTS, ...opts };
  const { sampleRate, bufferSize } = cfg;
  if (!sampleRate || !bufferSize) throw new Error('sampleRate et bufferSize requis');

  const minLag = Math.max(2, Math.floor(sampleRate / cfg.maxFreq));
  const maxLag = Math.min(Math.floor(sampleRate / cfg.minFreq), bufferSize - 1);
  const nsdf = new Float32Array(maxLag + 2);
  const work = new Float32Array(bufferSize);

  /**
   * @param {Float32Array} buffer échantillons temporels (-1..1)
   * @returns {{freq:number, clarity:number, rms:number}|{freq:0, clarity:number, rms:number}}
   */
  function detect(buffer) {
    const n = Math.min(buffer.length, bufferSize);

    // Retrait de la composante continue + niveau (RMS).
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buffer[i];
    mean /= n;
    let power = 0;
    for (let i = 0; i < n; i++) {
      const v = buffer[i] - mean;
      work[i] = v;
      power += v * v;
    }
    const rms = Math.sqrt(power / n);
    if (rms < cfg.rmsMin) return { freq: 0, clarity: 0, rms };

    // NSDF(tau) = 2*r(tau) / m(tau), dans [-1, 1] ; 1 = période parfaite.
    // m(tau) est mis à jour de façon incrémentale (récurrence de type YIN).
    let m = 2 * power;
    for (let tau = 1; tau <= maxLag; tau++) {
      m -= work[n - tau] * work[n - tau] + work[tau - 1] * work[tau - 1];
      if (tau < minLag) { nsdf[tau] = 0; continue; }
      let r = 0;
      const end = n - tau;
      for (let i = 0; i < end; i++) r += work[i] * work[i + tau];
      nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    }

    // Pics : un maximum local par plage où la NSDF est positive.
    let best = 0;
    let bestTau = 0;
    const peaks = [];
    let tau = minLag;
    while (tau <= maxLag) {
      if (nsdf[tau] <= 0) { tau++; continue; }
      let peakTau = tau;
      while (tau <= maxLag && nsdf[tau] > 0) {
        if (nsdf[tau] > nsdf[peakTau]) peakTau = tau;
        tau++;
      }
      peaks.push(peakTau);
      if (nsdf[peakTau] > best) { best = nsdf[peakTau]; bestTau = peakTau; }
    }
    if (!bestTau || best < cfg.clarityMin) return { freq: 0, clarity: best, rms };

    // Premier pic « assez haut » : évite les erreurs d'octave vers le bas.
    const cutoff = cfg.peakRatio * best;
    let chosen = bestTau;
    for (const p of peaks) {
      if (nsdf[p] >= cutoff) { chosen = p; break; }
    }

    // Interpolation parabolique sur trois points autour du pic.
    const y0 = nsdf[chosen - 1] || 0;
    const y1 = nsdf[chosen];
    const y2 = nsdf[chosen + 1] || 0;
    const denom = 2 * (2 * y1 - y0 - y2);
    const shift = denom !== 0 ? (y2 - y0) / denom : 0;
    const period = chosen + (Math.abs(shift) < 1 ? shift : 0);

    const freq = sampleRate / period;
    if (freq < cfg.minFreq || freq > cfg.maxFreq) return { freq: 0, clarity: y1, rms };
    return { freq, clarity: y1, rms };
  }

  return { detect, minLag, maxLag, config: cfg };
}

/**
 * Lissage d'une suite d'estimations : médiane (élimine les sauts d'octave
 * isolés) puis moyenne des valeurs proches de cette médiane.
 * @param {number[]} values fréquences en Hz
 * @param {number} toleranceCents écart max retenu autour de la médiane
 */
export function smoothFrequencies(values, toleranceCents = 40) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (Math.abs(1200 * Math.log2(v / median)) <= toleranceCents) { sum += v; count++; }
  }
  return count ? sum / count : median;
}
