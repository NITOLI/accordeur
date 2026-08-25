// Chaîne audio : micro -> filtres -> analyseur -> détecteur de hauteur.
// Expose aussi la note de référence (petit synthé) sur le même AudioContext.

import { createDetector } from './pitch.js';

const BUFFER_SIZE = 4096;   // taille de la FFT/analyseur
const WINDOW_SIZE = 3072;   // fenêtre réellement corrélée (compromis CPU/grave)
const FRAME_MS = 45;        // cadence d'analyse (~22 mesures par seconde)

export function createTuner({ onFrame, onError } = {}) {
  let ctx = null;
  let stream = null;
  let analyser = null;
  let detector = null;
  let buffer = null;
  let rafId = 0;
  let lastRun = 0;
  let running = false;
  let tone = null;

  async function start() {
    if (running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Ce navigateur n'expose pas le micro (getUserMedia).");
    }

    // On coupe les traitements du navigateur : ils déforment la hauteur.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);

    // Passe-bande large : on enlève les rumbles et le souffle aigu,
    // tout en gardant assez d'harmoniques pour l'autocorrélation.
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 55;
    highpass.Q.value = 0.7;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1400;
    lowpass.Q.value = 0.7;

    analyser = ctx.createAnalyser();
    analyser.fftSize = BUFFER_SIZE;
    analyser.smoothingTimeConstant = 0;

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(analyser);

    buffer = new Float32Array(BUFFER_SIZE);
    detector = createDetector({ sampleRate: ctx.sampleRate, bufferSize: WINDOW_SIZE });

    running = true;
    lastRun = 0;
    loop(0);
  }

  function loop(now) {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    if (now - lastRun < FRAME_MS) return;
    lastRun = now;
    try {
      analyser.getFloatTimeDomainData(buffer);
      onFrame?.(detector.detect(buffer.subarray(0, WINDOW_SIZE)));
    } catch (err) {
      onError?.(err);
      stop();
    }
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    analyser = null;
  }

  /** Joue (ou coupe) une note de référence : sinus + octave discrète. */
  function playTone(freq) {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    stopTone();

    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.04);
    gain.connect(ctx.destination);

    const oscs = [
      { ratio: 1, level: 1 },
      { ratio: 2, level: 0.22 },
      { ratio: 3, level: 0.08 },
    ].map(({ ratio, level }) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * ratio;
      g.gain.value = level;
      osc.connect(g);
      g.connect(gain);
      osc.start(t);
      return osc;
    });

    tone = { gain, oscs };
    return tone;
  }

  function stopTone() {
    if (!tone) return;
    const { gain, oscs } = tone;
    tone = null;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.06);
    oscs.forEach((osc) => osc.stop(t + 0.1));
    setTimeout(() => gain.disconnect(), 200);
  }

  return {
    start,
    stop,
    playTone,
    stopTone,
    isRunning: () => running,
    isTonePlaying: () => tone !== null,
    get sampleRate() { return ctx?.sampleRate || 0; },
  };
}
