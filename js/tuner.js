// Chaîne audio : micro -> filtres -> analyseur -> détecteur de hauteur.
// Expose aussi la note de référence, sur le même AudioContext.

import { createDetector } from './pitch.js';

const BUFFER_SIZE = 4096;   // taille de la FFT/analyseur
const WINDOW_SIZE = 3072;   // fenêtre réellement corrélée (compromis CPU/grave)
const FRAME_MS = 50;        // cadence d'analyse (20 mesures par seconde)

// La note de référence n'est pas un sinus pur : un haut-parleur de téléphone ne
// descend pas jusqu'au mi grave (82 Hz). Ce sont les harmoniques, entre 300 et
// 1500 Hz, qui la rendent audible — l'oreille reconstitue la fondamentale
// manquante et entend quand même la bonne note.
const TONE_PARTIALS = [1, 0.6, 0.4, 0.3, 0.22, 0.15];
const TONE_GAIN = 0.2;
const TONE_PEAK = TONE_GAIN * TONE_PARTIALS.reduce((a, b) => a + b, 0);

/**
 * Sous iOS, un flux micro ouvert fait basculer la session audio en
 * « enregistrement + lecture », qui sort par l'écouteur téléphonique : le son
 * devient inaudible même à fond. On demande donc explicitement « lecture »
 * pendant la note de référence, puis on revient à l'état précédent.
 */
function setAudioSession(type) {
  try {
    if ('audioSession' in navigator) navigator.audioSession.type = type;
  } catch {
    /* API absente ou refusée : le reste fonctionne quand même */
  }
}

export function createTuner({ onFrame, onError } = {}) {
  let ctx = null;
  let stream = null;
  let chain = [];        // nœuds du graphe d'entrée, à débrancher à la fermeture
  let analyser = null;
  let detector = null;
  let buffer = null;
  let rafId = 0;
  let lastRun = 0;
  let running = false;   // le micro est réellement ouvert
  let micWanted = false; // l'utilisateur veut le micro (indépendant de la pause)
  let tone = null;

  function audioContext() {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  /** Ouvre le micro et lance la boucle d'analyse. */
  async function openMic() {
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

    const ac = audioContext();
    await ac.resume();
    const source = ac.createMediaStreamSource(stream);

    // Passe-bande large : on enlève les rumbles et le souffle aigu, tout en
    // gardant assez d'harmoniques pour l'autocorrélation.
    const highpass = ac.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 55;
    highpass.Q.value = 0.7;

    const lowpass = ac.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 1400;
    lowpass.Q.value = 0.7;

    analyser = ac.createAnalyser();
    analyser.fftSize = BUFFER_SIZE;
    analyser.smoothingTimeConstant = 0;

    source.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(analyser);
    chain = [source, highpass, lowpass, analyser];

    buffer = new Float32Array(BUFFER_SIZE);
    detector = createDetector({ sampleRate: ac.sampleRate, bufferSize: WINDOW_SIZE });

    running = true;
    lastRun = 0;
    loop(0);
  }

  /** Ferme le micro et libère la session d'enregistrement. */
  function closeMic() {
    running = false;
    cancelAnimationFrame(rafId);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    chain.forEach((node) => node.disconnect());
    chain = [];
    analyser = null;
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
      closeMic();
      micWanted = false;
    }
  }

  async function start() {
    micWanted = true;
    try {
      await openMic();
    } catch (err) {
      micWanted = false;
      throw err;
    }
  }

  function stop() {
    micWanted = false;
    closeMic();
    setAudioSession('auto');
  }

  /**
   * Libère la session d'enregistrement pour jouer du son : sous iOS c'est la
   * condition pour sortir par le haut-parleur et non par l'écouteur. Sert à la
   * note de référence comme au métronome.
   */
  async function suspendForPlayback() {
    if (running) closeMic();
    setAudioSession('playback');
    await audioContext().resume();
  }

  /** Rend la main au micro si l'utilisateur le voulait. */
  async function resumeAfterPlayback() {
    setAudioSession(micWanted ? 'play-and-record' : 'auto');
    if (micWanted && !running) await openMic();
  }

  /**
   * Joue la note de référence, micro fermé le temps de l'écoute — ce qui évite
   * en prime que la note jouée soit analysée comme si c'était la corde.
   */
  async function playTone(freq) {
    const ac = audioContext();

    // Déjà en train de jouer : on se contente de changer la hauteur.
    if (tone) {
      tone.oscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freq * (i + 1), ac.currentTime, 0.02);
      });
      tone.freq = freq;
      return;
    }

    await suspendForPlayback();

    const t = ac.currentTime;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(TONE_GAIN, t + 0.05);
    gain.connect(ac.destination);

    const oscs = TONE_PARTIALS.map((level, i) => {
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * (i + 1);
      g.gain.value = level;
      osc.connect(g);
      g.connect(gain);
      osc.start(t);
      return osc;
    });

    tone = { gain, oscs, freq };
  }

  /** Coupe la note et rouvre le micro si l'utilisateur le voulait. */
  async function stopTone() {
    if (tone) {
      const { gain, oscs } = tone;
      tone = null;
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.06);
      oscs.forEach((osc) => osc.stop(t + 0.12));
      setTimeout(() => gain.disconnect(), 250);
    }
    await resumeAfterPlayback();
  }

  return {
    start,
    stop,
    playTone,
    stopTone,
    context: audioContext,
    suspendForPlayback,
    resumeAfterPlayback,
    isRunning: () => running,
    isMicOn: () => micWanted,
    isTonePlaying: () => tone !== null,
    tonePeak: () => TONE_PEAK,
    tonePartials: () => [...TONE_PARTIALS],
    get sampleRate() { return ctx?.sampleRate || 0; },
  };
}
