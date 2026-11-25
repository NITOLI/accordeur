// Métronome. La justesse vient d'un ordonnanceur à anticipation : un réveil
// fréquent programme les clics à l'avance sur l'horloge de l'AudioContext, qui
// est échantillon-exacte. Le fil principal peut bégayer, les clics tombent
// quand même pile — c'est la seule façon d'avoir un tempo tenable sur le web.

const LOOKAHEAD_MS = 25;    // à quelle fréquence on regarde devant soi
const SCHEDULE_AHEAD = 0.1; // de combien de secondes on programme à l'avance

export const MIN_BPM = 30;
export const MAX_BPM = 250;

/** Indication de tempo correspondant à un nombre de battements par minute. */
export function tempoName(bpm) {
  if (bpm < 40) return 'Grave';
  if (bpm < 60) return 'Largo';
  if (bpm < 66) return 'Larghetto';
  if (bpm < 76) return 'Adagio';
  if (bpm < 108) return 'Andante';
  if (bpm < 120) return 'Moderato';
  if (bpm < 168) return 'Allegro';
  if (bpm < 200) return 'Vivace';
  if (bpm < 208) return 'Presto';
  return 'Prestissimo';
}

/**
 * Tempo déduit d'une suite de frappes (en millisecondes).
 * On écarte les intervalles aberrants autour de la médiane : une frappe
 * hésitante ne doit pas emporter le tempo.
 */
export function tapToBpm(times) {
  if (times.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const kept = gaps.filter((g) => g >= median * 0.6 && g <= median * 1.7);
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  if (!mean || mean > 2000) return null;
  return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(60000 / mean)));
}

/**
 * @param {{context:() => AudioContext, onBeat?:(beat:{index:number, inBar:number, accent:boolean}) => void}} opts
 */
export function createMetronome({ context, onBeat } = {}) {
  let bpm = 90;
  let beatsPerBar = 4;
  let running = false;
  let timer = 0;
  let rafId = 0;
  let origin = 0;      // temps audio du battement d'indice 0
  let nextIndex = 0;   // prochain battement à programmer
  let nextInBar = 0;   // sa position dans la mesure
  let queue = [];      // battements programmés, en attente d'affichage
  let output = null;   // gain de sortie, créé à la volée

  const spb = () => 60 / bpm;
  const beatTime = (index) => origin + index * spb();

  /** Un clic bref : attaque immédiate, extinction en 45 ms. */
  function scheduleClick(time, accent) {
    const ctx = context();
    if (!output) {
      output = ctx.createGain();
      output.gain.value = 1;
      output.connect(ctx.destination);
    }
    const gain = ctx.createGain();
    const level = accent ? 0.5 : 0.3;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(level, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    gain.connect(output);

    // Deux partiels : un corps et un grain plus aigu, pour que le clic passe
    // sur un petit haut-parleur sans être strident.
    for (const [ratio, mix, type] of [[1, 1, 'triangle'], [2.6, 0.35, 'sine']]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime((accent ? 1500 : 1050) * ratio, time);
      g.gain.value = mix;
      osc.connect(g);
      g.connect(gain);
      osc.start(time);
      osc.stop(time + 0.06);
    }
    setTimeout(() => gain.disconnect(), (time - ctx.currentTime) * 1000 + 300);
  }

  function scheduler() {
    const ctx = context();
    while (beatTime(nextIndex) < ctx.currentTime + SCHEDULE_AHEAD) {
      const time = beatTime(nextIndex);
      const accent = nextInBar === 0 && beatsPerBar > 1;
      scheduleClick(time, accent);
      queue.push({ time, index: nextIndex, inBar: nextInBar, accent });
      nextIndex++;
      nextInBar = (nextInBar + 1) % beatsPerBar;
    }
  }

  /** Signale les battements à l'interface au moment où ils sonnent. */
  function visualLoop() {
    if (!running) return;
    rafId = requestAnimationFrame(visualLoop);
    const now = context().currentTime;
    while (queue.length && queue[0].time <= now) onBeat?.(queue.shift());
  }

  async function start() {
    if (running) return;
    const ctx = context();
    await ctx.resume();
    running = true;
    queue = [];
    nextIndex = 0;
    nextInBar = 0;
    origin = ctx.currentTime + 0.12; // un souffle d'avance avant le 1er clic
    scheduler();
    timer = setInterval(scheduler, LOOKAHEAD_MS);
    visualLoop();
  }

  function stop() {
    running = false;
    clearInterval(timer);
    cancelAnimationFrame(rafId);
    queue = [];
  }

  /**
   * Change le tempo sans décaler le prochain battement déjà attendu :
   * le nouvel espacement ne s'applique qu'après lui.
   */
  function setTempo(value) {
    const next = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(value)));
    if (next === bpm) return bpm;
    if (running) {
      const keep = beatTime(nextIndex);
      bpm = next;
      origin = keep - nextIndex * spb();
    } else {
      bpm = next;
    }
    return bpm;
  }

  function setBeatsPerBar(n) {
    beatsPerBar = Math.max(1, Math.min(12, Math.round(n)));
    if (nextInBar >= beatsPerBar) nextInBar = 0;
    return beatsPerBar;
  }

  return {
    start,
    stop,
    setTempo,
    setBeatsPerBar,
    isRunning: () => running,
    getTempo: () => bpm,
    getBeatsPerBar: () => beatsPerBar,
  };
}
