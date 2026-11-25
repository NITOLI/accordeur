// Interface de l'accordeur : cadran, cordes, réglages, note de référence.

import { createTuner } from './tuner.js';
import { createMetronome, tempoName, tapToBpm, MIN_BPM, MAX_BPM } from './metronome.js';
import { smoothFrequencies } from './pitch.js';
import { centsBetween, midiToFreq, midiToNote, nearestNote } from './notes.js';
import { TUNINGS, DEFAULT_TUNING_ID, getTuning, tuningStrings, tuningSummary } from './tunings.js';

/* ---------------------------------------------------------------- réglages */

const STORE_KEY = 'accordeur.settings.v1';

const settings = Object.assign(
  { tuningId: DEFAULT_TUNING_ID, a4: 440, strict: false, haptic: true, auto: true,
    response: 'equilibre', bpm: 90, beatsPerBar: 4 },
  readSettings()
);

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* mode navigation privée : on continue sans mémoriser */
  }
}

/* ------------------------------------------------------------------- états */

// Une trame d'analyse dure 50 ms. Ces valeurs règlent la nervosité de
// l'affichage : assez lent pour que l'aiguille ne tremble pas, assez vif pour
// suivre la mécanique qu'on tourne.
const HOLD_TUNED_MS = 400;      // durée dans la zone juste pour valider
const HOLD_UNTUNED_MS = 700;    // durée hors zone pour invalider
const SWITCH_FRAMES = 6;        // ~300 ms avant de changer de corde en auto
const CLARITY_TUNED = 0.8;      // périodicité minimale pour valider une corde (> CLARITY_SHOW)
const CLARITY_SHOW = 0.72;      // en dessous, on garde l'affichage précédent
                                // plutôt que de suivre une mesure douteuse
const EASE_SPAN = 10;           // écart, en cents, à partir duquel on suit à fond

// Réactivité : trois dosages du même compromis. « history » est le nombre de
// trames de 50 ms lissées ensemble, « near » et « far » la vitesse de suivi
// près du juste et loin de lui, « silence » le nombre de trames muettes avant
// de revenir au repos.
const RESPONSE = {
  vif:       { label: 'Vif',       history: 4,  near: 0.26, far: 0.50, silence: 8 },
  equilibre: { label: 'Équilibré', history: 7,  near: 0.14, far: 0.40, silence: 11 },
  // « posé » garde la fenêtre d'« équilibré » : l'allonger faisait battre la
  // médiane contre le vibrato de la corde, ce qui agitait l'aiguille au lieu
  // de la calmer. Seul le suivi est ralenti.
  pose:      { label: 'Posé',      history: 7,  near: 0.08, far: 0.30, silence: 14 },
};
const RESPONSE_HINT = {
  vif: "L'aiguille suit la corde au plus près. Elle tremble un peu.",
  equilibre: 'Le compromis par défaut.',
  pose: "L'aiguille est très stable, au prix d'un léger retard.",
};

function resp() {
  return RESPONSE[settings.response] || RESPONSE.equilibre;
}

const state = {
  strings: [],
  targetIndex: 0,
  candidateIndex: -1,
  candidateCount: 0,
  tuned: new Set(),
  history: [],
  silence: 0,
  inZoneSince: 0,
  outZoneSince: 0,
  displayCents: 0,
  idle: true,
};

/* ------------------------------------------------------------------- DOM */

const el = {
  gauge: document.getElementById('gauge'),
  ticks: document.getElementById('gaugeTicks'),
  green: document.getElementById('gaugeGreen'),
  needle: document.getElementById('needle'),
  note: document.getElementById('noteName'),
  cents: document.getElementById('centsText'),
  freq: document.getElementById('freqText'),
  target: document.getElementById('targetText'),
  advice: document.getElementById('adviceText'),
  strings: document.getElementById('strings'),
  tuningName: document.getElementById('tuningName'),
  tuningBtn: document.getElementById('tuningBtn'),
  tuningList: document.getElementById('tuningList'),
  settingsDlg: document.getElementById('settingsDlg'),
  a4Value: document.getElementById('a4Value'),
  a4Range: document.getElementById('a4Range'),
  a4Minus: document.getElementById('a4Minus'),
  a4Plus: document.getElementById('a4Plus'),
  responseList: document.getElementById('responseList'),
  responseHint: document.getElementById('responseHint'),
  strictChk: document.getElementById('strictChk'),
  hapticChk: document.getElementById('hapticChk'),
  modeBtn: document.getElementById('modeBtn'),
  modeLabel: document.getElementById('modeLabel'),
  micBtn: document.getElementById('micBtn'),
  toneBtn: document.getElementById('toneBtn'),
  gate: document.getElementById('gate'),
  gateBtn: document.getElementById('gateBtn'),
  gateSkip: document.getElementById('gateSkip'),
  gateNote: document.getElementById('gateNote'),
  toast: document.getElementById('toast'),
  // métronome
  metroBtn: document.getElementById('metroBtn'),
  backBtn: document.getElementById('backBtn'),
  beats: document.getElementById('beats'),
  bpmValue: document.getElementById('bpmValue'),
  tempoName: document.getElementById('tempoName'),
  bpmRange: document.getElementById('bpmRange'),
  bpmMinus: document.getElementById('bpmMinus'),
  bpmPlus: document.getElementById('bpmPlus'),
  signatures: document.getElementById('signatures'),
  tapBtn: document.getElementById('tapBtn'),
  playBtn: document.getElementById('playBtn'),
  app: document.querySelector('.app'),
};

const SVG_NS = 'http://www.w3.org/2000/svg';
const CENTER = { x: 160, y: 152 };
const MAX_CENTS = 50;
const MAX_ANGLE = 45;

function tolerance() {
  return settings.strict ? 2 : 5;
}

function polar(radius, angleDeg) {
  const a = (angleDeg * Math.PI) / 180;
  return { x: CENTER.x + radius * Math.sin(a), y: CENTER.y - radius * Math.cos(a) };
}

/* ------------------------------------------------------------- rendu fixe */

function buildGauge() {
  const frag = document.createDocumentFragment();
  for (let cents = -MAX_CENTS; cents <= MAX_CENTS; cents += 5) {
    const angle = (cents / MAX_CENTS) * MAX_ANGLE;
    const major = cents % 25 === 0;
    const inner = polar(major ? 112 : 120, angle);
    const outer = polar(134, angle);
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', inner.x.toFixed(1));
    line.setAttribute('y1', inner.y.toFixed(1));
    line.setAttribute('x2', outer.x.toFixed(1));
    line.setAttribute('y2', outer.y.toFixed(1));
    line.setAttribute('class', `tick${major ? ' major' : ''}${cents === 0 ? ' center' : ''}`);
    frag.appendChild(line);

    if (major) {
      const p = polar(147, angle);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', p.x.toFixed(1));
      text.setAttribute('y', (p.y + 4).toFixed(1));
      text.setAttribute('class', 'tick-label');
      text.textContent = cents === 0 ? '0' : (cents > 0 ? `+${cents}` : `${cents}`);
      frag.appendChild(text);
    }
  }
  el.ticks.replaceChildren(frag);
  drawGreenZone();
}

function drawGreenZone() {
  const angle = (tolerance() / MAX_CENTS) * MAX_ANGLE;
  const a = polar(140, -angle);
  const b = polar(140, angle);
  el.green.setAttribute('d', `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A 140 140 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
  el.green.setAttribute('stroke-width', tolerance() >= 5 ? 7 : 5);
}

function buildStrings() {
  state.strings = tuningStrings(getTuning(settings.tuningId));
  state.tuned.clear();
  if (state.targetIndex >= state.strings.length) state.targetIndex = 0;

  const frag = document.createDocumentFragment();
  state.strings.forEach((s) => {
    const { name, octave } = midiToNote(s.midi);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'string';
    btn.dataset.index = String(s.index);
    btn.dataset.state = 'idle';
    btn.innerHTML =
      `<span class="name">${name}<sub>${octave}</sub></span>` +
      `<span class="num">${s.number}</span>` +
      `<span class="check" aria-hidden="true">✓</span>`;
    btn.setAttribute('aria-label', `Corde ${s.number}, ${name}${octave}`);
    btn.addEventListener('click', () => selectString(s.index));
    frag.appendChild(btn);
  });
  el.strings.replaceChildren(frag);

  el.tuningName.textContent = getTuning(settings.tuningId).name;
  renderStrings();
  renderTargetLine();
}

function buildTuningList() {
  const frag = document.createDocumentFragment();
  TUNINGS.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tuning';
    btn.setAttribute('aria-pressed', String(t.id === settings.tuningId));
    btn.innerHTML = `<strong>${t.name}</strong><span>${tuningSummary(t)}</span>`;
    btn.addEventListener('click', () => {
      settings.tuningId = t.id;
      saveSettings();
      buildStrings();
      buildTuningList();
      if (tuner.isTonePlaying()) {
        // La note de référence suit la corde visée : sinon on accorderait à
        // l'oreille sur l'ancienne hauteur.
        tuner.playTone(targetFreq());
        renderListening();
      } else {
        resetDetection();
      }
      toast(`Accordage : ${t.name}`);
    });
    frag.appendChild(btn);
  });
  el.tuningList.replaceChildren(frag);
}

function buildResponsePicker() {
  const frag = document.createDocumentFragment();
  for (const [id, preset] of Object.entries(RESPONSE)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'segment';
    btn.textContent = preset.label;
    btn.setAttribute('aria-pressed', String(id === settings.response));
    btn.addEventListener('click', () => {
      settings.response = id;
      saveSettings();
      buildResponsePicker();
      state.history.length = 0;
      toast(`Réactivité : ${preset.label.toLowerCase()}`);
    });
    frag.appendChild(btn);
  }
  el.responseList.replaceChildren(frag);
  el.responseHint.textContent = RESPONSE_HINT[settings.response] || RESPONSE_HINT.equilibre;
}

/* -------------------------------------------------------------- rendu live */

function targetFreq(index = state.targetIndex) {
  return midiToFreq(state.strings[index].midi, settings.a4);
}

function renderStrings() {
  el.strings.querySelectorAll('.string').forEach((btn) => {
    const i = Number(btn.dataset.index);
    btn.dataset.state = state.tuned.has(i) ? 'tuned' : i === state.targetIndex ? 'active' : 'idle';
    btn.setAttribute('aria-pressed', String(i === state.targetIndex));
  });
}

/** Conseil affiché sous le cadran : quoi faire, là, tout de suite. */
function setAdvice(html, ok = false) {
  if (el.advice.innerHTML !== html) el.advice.innerHTML = html;
  el.advice.classList.toggle('ok', ok);
}

function nextStringNumber() {
  const next = state.strings.find((s) => !state.tuned.has(s.index));
  return next ? next.number : null;
}

function adviceFor(cents) {
  const tol = tolerance();
  const s = state.strings[state.targetIndex];
  const strength = Math.abs(cents) > 25 ? 'nettement ' : '';

  if (Math.abs(cents) > tol) {
    return cents < 0
      ? [`<b>Tends</b> ${strength}la corde ${s.number} : elle est trop grave.`, false]
      : [`<b>Détends</b> ${strength}la corde ${s.number} : elle est trop aiguë.`, false];
  }
  if (!state.tuned.has(state.targetIndex)) return ['Presque : garde la note un instant…', false];

  const next = nextStringNumber();
  if (!next) return ['Les six cordes sont justes. Vérifie avec un accord.', true];
  return [`Corde ${s.number} juste. Passe à la <b>corde ${next}</b>.`, true];
}

function renderTargetLine() {
  const s = state.strings[state.targetIndex];
  const { name, octave } = midiToNote(s.midi);
  const mode = settings.auto ? 'auto' : 'manuel';
  el.target.textContent = `Corde ${s.number} · ${name}${octave} · ${targetFreq().toFixed(2)} Hz (${mode})`;
}

// Zone morte : sous un quart de degré, on ne redessine pas. Ce résidu-là ne
// dit rien de la corde, il ne fait que trembler.
const NEEDLE_DEADBAND = 0.25;
let needleAngle = null;

function setNeedle(cents, cls) {
  const clamped = Math.max(-MAX_CENTS, Math.min(MAX_CENTS, cents));
  const angle = (clamped / MAX_CENTS) * MAX_ANGLE;
  if (needleAngle === null || Math.abs(angle - needleAngle) >= NEEDLE_DEADBAND) {
    needleAngle = angle;
    el.needle.setAttribute('transform', `rotate(${angle.toFixed(2)} ${CENTER.x} ${CENTER.y})`);
  }
  el.gauge.className = `gauge ${cls}`;
}

function renderIdle() {
  state.idle = true;
  state.history.length = 0;
  state.inZoneSince = 0;
  state.outZoneSince = 0;
  state.displayCents = 0;
  setNeedle(0, 'is-idle');
  const s = state.strings[state.targetIndex];
  const { name, octave } = midiToNote(s.midi);
  el.note.innerHTML = `${name}<sub>${octave}</sub>`;
  el.cents.textContent = tuner.isMicOn() ? 'Joue une corde' : 'Micro en pause';
  el.freq.innerHTML = '&nbsp;';
  if (!tuner.isMicOn()) {
    setAdvice('Active le micro pour commencer.');
  } else if (state.tuned.size === state.strings.length) {
    setAdvice('Les six cordes sont justes. Vérifie avec un accord.', true);
  } else {
    const next = nextStringNumber();
    setAdvice(`Joue la <b>corde ${next}</b> à vide, une seule à la fois.`);
  }
}

/** Pendant la note de référence : le micro est fermé, on écoute. */
function renderListening() {
  const s = state.strings[state.targetIndex];
  const { name, octave } = midiToNote(s.midi);
  setNeedle(0, 'is-idle');
  el.note.innerHTML = `${name}<sub>${octave}</sub>`;
  el.cents.textContent = 'Écoute la note';
  el.freq.textContent = `${targetFreq().toFixed(1)} Hz — micro en pause`;
  setAdvice(`Compare à l'oreille, puis coupe le son pour accorder la <b>corde ${s.number}</b>.`);
}

function render(freq, cents) {
  const tol = tolerance();
  const s = state.strings[state.targetIndex];
  const { name, octave } = midiToNote(s.midi);
  const cls = Math.abs(cents) <= tol ? 'is-tuned' : cents < 0 ? 'is-low' : 'is-high';

  setNeedle(cents, cls);
  el.note.innerHTML = `${name}<sub>${octave}</sub>`;

  if (Math.abs(cents) <= tol) {
    el.cents.textContent = state.tuned.has(state.targetIndex) ? 'Juste ✓' : 'Juste';
  } else if (cents < -MAX_CENTS) {
    el.cents.textContent = '▼ beaucoup trop bas';
  } else if (cents > MAX_CENTS) {
    el.cents.textContent = '▲ beaucoup trop haut';
  } else {
    const arrow = cents < 0 ? '▼ trop bas' : '▲ trop haut';
    const round = Math.round(cents);
    el.cents.textContent = `${arrow} · ${round > 0 ? '+' : ''}${round} cents`;
  }

  const [advice, ok] = adviceFor(cents);
  setAdvice(advice, ok);

  const heard = nearestNote(freq, settings.a4);
  const heardNote = midiToNote(heard.midi);
  el.freq.textContent = `${freq.toFixed(1)} Hz — entendu : ${heardNote.name}${heardNote.octave}`;
}

/* ---------------------------------------------------------------- logique */

function selectString(index) {
  // Taper une corde la fixe : on passe donc en mode manuel.
  state.targetIndex = index;
  setMode(false, { silent: true });
  state.candidateIndex = -1;
  state.candidateCount = 0;
  state.inZoneSince = 0;
  renderStrings();
  renderTargetLine();
  if (tuner.isTonePlaying()) {
    tuner.playTone(targetFreq());
    renderListening();   // sinon l'écran garde la fréquence de la corde d'avant
  } else if (state.idle) {
    renderIdle();
  }
}

function setMode(auto, { silent = false } = {}) {
  settings.auto = auto;
  saveSettings();
  el.modeBtn.setAttribute('aria-pressed', String(auto));
  el.modeLabel.textContent = auto ? 'Auto' : `Corde ${state.strings[state.targetIndex].number}`;
  renderTargetLine();
  if (!silent) toast(auto ? 'Détection automatique de la corde' : 'Corde choisie à la main');
}

function resetDetection() {
  state.history.length = 0;
  state.candidateIndex = -1;
  state.candidateCount = 0;
  state.inZoneSince = 0;
  state.outZoneSince = 0;
  renderIdle();
}

/** En mode auto : corde la plus proche, avec une hystérésis anti-clignotement. */
function pickString(freq) {
  let best = 0;
  let bestDist = Infinity;
  state.strings.forEach((s, i) => {
    const dist = Math.abs(centsBetween(freq, midiToFreq(s.midi, settings.a4)));
    if (dist < bestDist) { bestDist = dist; best = i; }
  });

  if (best === state.targetIndex) {
    state.candidateIndex = -1;
    state.candidateCount = 0;
    return;
  }
  // On ne bascule que si la nouvelle corde est nettement plus proche,
  // confirmée sur plusieurs trames : sinon un harmonique fait sauter la cible.
  const currentDist = Math.abs(centsBetween(freq, targetFreq()));
  if (bestDist > currentDist - 60) return;

  if (best === state.candidateIndex) state.candidateCount++;
  else { state.candidateIndex = best; state.candidateCount = 1; }

  if (state.candidateCount >= SWITCH_FRAMES) {
    state.targetIndex = best;
    state.candidateIndex = -1;
    state.candidateCount = 0;
    state.inZoneSince = 0;
    state.outZoneSince = 0;
    renderStrings();
    renderTargetLine();
  }
}

function markTuned(index) {
  if (state.tuned.has(index)) return;
  state.tuned.add(index);
  renderStrings();
  if (settings.haptic) navigator.vibrate?.(60);
  const allTuned = state.tuned.size === state.strings.length;
  toast(allTuned ? 'Guitare accordée 🎸' : `Corde ${state.strings[index].number} accordée`);
}

function unmarkTuned(index) {
  if (!state.tuned.delete(index)) return;
  renderStrings();
}

function onFrame({ freq, clarity }) {
  const now = performance.now();

  // Trame muette, ou périodicité trop faible pour être crue : on ne bouge pas.
  // C'est le cas dans la queue d'une note, quand le bruit prend le dessus.
  if (!freq || clarity < CLARITY_SHOW) {
    if (++state.silence >= resp().silence && !state.idle) renderIdle();
    return;
  }
  state.silence = 0;
  state.idle = false;

  state.history.push(freq);
  while (state.history.length > resp().history) state.history.shift();
  const smooth = smoothFrequencies(state.history);

  if (settings.auto) pickString(smooth);

  const rawCents = centsBetween(smooth, targetFreq());
  // Lissage adaptatif : la vitesse de suivi croît avec le carré de l'écart.
  // Tourner une mécanique est suivi tout de suite ; le tremblement de quelques
  // cents autour de la note, lui, reste amorti.
  const { near, far } = resp();
  const err = Math.abs(rawCents - state.displayCents);
  const ramp = Math.min(1, err / EASE_SPAN) ** 2;
  const alpha = near + (far - near) * ramp;
  state.displayCents += (rawCents - state.displayCents) * alpha;
  const cents = state.displayCents;

  const tol = tolerance();
  if (Math.abs(cents) <= tol && clarity >= CLARITY_TUNED) {
    state.outZoneSince = 0;
    if (!state.inZoneSince) state.inZoneSince = now;
    else if (now - state.inZoneSince >= HOLD_TUNED_MS) markTuned(state.targetIndex);
  } else {
    state.inZoneSince = 0;
    if (Math.abs(cents) > 20 && state.tuned.has(state.targetIndex)) {
      if (!state.outZoneSince) state.outZoneSince = now;
      else if (now - state.outZoneSince >= HOLD_UNTUNED_MS) unmarkTuned(state.targetIndex);
    } else {
      state.outZoneSince = 0;
    }
  }

  render(smooth, cents);
}

/* ------------------------------------------------------------------ micro */

const tuner = createTuner({
  onFrame,
  // Le tuner a coupé le micro de lui-même : l'écran doit le refléter.
  onError: (err) => {
    stopMic();
    toast(`Erreur audio : ${err.message}`);
  },
});

// L'écran reste allumé tant que le micro écoute ou que le métronome tourne.
// Un seul verrou à la fois : en demander un second sans rendre le premier
// laisserait l'écran allumé après l'arrêt.
let wakeLock = null;
let wakeLockPending = false;

const needsWakeLock = () => tuner.isMicOn() || metronome.isRunning();

async function requestWakeLock() {
  if (wakeLock || wakeLockPending) return;
  wakeLockPending = true;
  try {
    const lock = await navigator.wakeLock?.request('screen');
    if (!lock) return;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    if (needsWakeLock()) wakeLock = lock;
    else lock.release();   // tout s'est arrêté pendant l'attente
  } catch {
    /* non disponible : sans conséquence pour l'accordage */
  } finally {
    wakeLockPending = false;
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  lock?.release?.();
}

/** Prend ou rend le verrou selon ce qui tourne. */
function syncWakeLock() {
  if (needsWakeLock()) requestWakeLock();
  else releaseWakeLock();
}

async function startMic() {
  try {
    el.micBtn.disabled = true;
    el.gateBtn.disabled = true;
    await tuner.start();   // coupe au passage la note de référence, si elle jouait
    el.toneBtn.setAttribute('aria-pressed', String(tuner.isTonePlaying()));
    el.gate.hidden = true;
    el.micBtn.textContent = 'Couper le micro';
    el.micBtn.classList.add('is-on');
    resetDetection();
    syncWakeLock();
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    const msg = denied
      ? "Micro refusé. Autorise-le dans les réglages du navigateur, puis réessaie."
      : `Micro indisponible : ${err.message}`;
    el.gateNote.textContent = msg;
    toast(msg);
  } finally {
    el.micBtn.disabled = false;
    el.gateBtn.disabled = false;
  }
}

function stopMic() {
  tuner.stop();
  syncWakeLock();
  el.micBtn.textContent = 'Activer le micro';
  el.micBtn.classList.remove('is-on');
  renderIdle();
}

/* -------------------------------------------------------------- métronome */

const metronome = createMetronome({
  context: () => tuner.context(),
  onBeat: (beat) => flashBeat(beat),
});

const SIGNATURES = [
  { beats: 2, label: '2/4' },
  { beats: 3, label: '3/4' },
  { beats: 4, label: '4/4' },
  { beats: 6, label: '6/8' },
];

function buildBeats() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < settings.beatsPerBar; i++) {
    const dot = document.createElement('span');
    dot.className = i === 0 && settings.beatsPerBar > 1 ? 'beat accent' : 'beat';
    frag.appendChild(dot);
  }
  el.beats.replaceChildren(frag);
}

function buildSignatures() {
  const frag = document.createDocumentFragment();
  for (const sig of SIGNATURES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'signature';
    btn.textContent = sig.label;
    btn.setAttribute('aria-pressed', String(sig.beats === settings.beatsPerBar));
    btn.addEventListener('click', () => {
      settings.beatsPerBar = metronome.setBeatsPerBar(sig.beats);
      saveSettings();
      buildSignatures();
      buildBeats();
    });
    frag.appendChild(btn);
  }
  el.signatures.replaceChildren(frag);
}

/**
 * Le temps courant reste allumé jusqu'au suivant : on voit le battement, mais
 * aussi où on en est dans la mesure. Un éclat bref, lui, serait invisible au
 * moindre à-coup d'affichage.
 */
function flashBeat({ inBar }) {
  const dots = el.beats.children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i === inBar);
}

function clearBeats() {
  for (const dot of el.beats.children) dot.classList.remove('on');
}

function renderTempo() {
  el.bpmValue.textContent = String(settings.bpm);
  el.tempoName.textContent = tempoName(settings.bpm);
  el.bpmRange.value = String(settings.bpm);
}

function setTempo(value) {
  settings.bpm = metronome.setTempo(value);
  saveSettings();
  renderTempo();
}

async function toggleMetronome() {
  if (metronome.isRunning()) {
    metronome.stop();
    el.playBtn.textContent = 'Démarrer';
    el.playBtn.classList.remove('is-on');
    clearBeats();
    syncWakeLock();
  } else {
    try {
      await metronome.start();
    } catch (err) {
      toast(`Son indisponible : ${err.message}`);
      return;
    }
    // Un arrêt (second tap, retour à l'accordeur) a pu passer pendant l'attente.
    if (!metronome.isRunning()) return;
    el.playBtn.textContent = 'Arrêter';
    el.playBtn.classList.add('is-on');
    syncWakeLock();
  }
}

let taps = [];
function tapTempo() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
  taps.push(now);
  if (taps.length > 5) taps.shift();
  const bpm = tapToBpm(taps);
  if (bpm) {
    setTempo(bpm);
    el.tapBtn.textContent = `${bpm} bpm`;
  } else {
    el.tapBtn.textContent = 'Encore…';
  }
  clearTimeout(tapTempo.reset);
  tapTempo.reset = setTimeout(() => { el.tapBtn.textContent = 'Frappe le tempo'; }, 2500);
}

/** Bascule entre accordeur et métronome : un seul des deux prend le son. */
async function showView(view) {
  el.app.dataset.show = view;
  try {
    if (view === 'metro') {
      // Micro laissé fermé : le métronome prend la main, inutile de le rouvrir.
      await stopToneUI({ resume: false });
      await tuner.suspendForPlayback();   // libère l'enregistrement (haut-parleur sous iOS)
    } else {
      if (metronome.isRunning()) await toggleMetronome();
      await tuner.resumeAfterPlayback();
      resetDetection();
    }
  } catch (err) {
    // Le micro n'a pas pu rouvrir : l'écran doit dire qu'il est éteint.
    toast(`Audio indisponible : ${err.message}`);
    if (view === 'tuner') stopMic();
  }
}

/**
 * Coupe la note de référence et remet l'écran d'écoute à zéro. L'écran est
 * mis à jour tout de suite : la réouverture du micro, elle, peut être longue.
 */
function stopToneUI(options) {
  if (!tuner.isTonePlaying()) return Promise.resolve();
  const done = tuner.stopTone(options);
  el.toneBtn.setAttribute('aria-pressed', 'false');
  resetDetection();
  return done;
}

/* ------------------------------------------------------------------ toast */

let toastTimer = 0;
let toastAction = null;

function toast(message, { action = null, duration = action ? 9000 : 2200 } = {}) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  el.toast.classList.toggle('tappable', Boolean(action));
  toastAction = action;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  el.toast.classList.remove('show', 'tappable');
  toastAction = null;
}

el.toast.addEventListener('click', () => {
  const run = toastAction;
  hideToast();
  run?.();
});

/* ------------------------------------------------------------- évènements */

el.gateBtn.addEventListener('click', startMic);
// Le métronome et la note de référence n'ont pas besoin du micro.
el.gateSkip.addEventListener('click', () => { el.gate.hidden = true; });
el.micBtn.addEventListener('click', () => (tuner.isMicOn() ? stopMic() : startMic()));
el.modeBtn.addEventListener('click', () => setMode(!settings.auto));

el.toneBtn.addEventListener('click', async () => {
  el.toneBtn.disabled = true;
  try {
    if (tuner.isTonePlaying()) {
      await stopToneUI();
    } else {
      await tuner.playTone(targetFreq());
      // Un arrêt a pu passer pendant l'attente : on n'affiche que ce qui joue.
      if (tuner.isTonePlaying()) {
        el.toneBtn.setAttribute('aria-pressed', 'true');
        renderListening();
      }
    }
  } catch (err) {
    toast(`Son indisponible : ${err.message}`);
  } finally {
    el.toneBtn.disabled = false;
  }
});

el.tuningBtn.addEventListener('click', () => el.settingsDlg.showModal());

function setA4(value) {
  settings.a4 = Math.max(415, Math.min(465, Math.round(value)));
  saveSettings();
  el.a4Value.textContent = `${settings.a4} Hz`;
  el.a4Range.value = String(settings.a4);
  state.tuned.clear();
  renderStrings();
  renderTargetLine();
  if (tuner.isTonePlaying()) {
    tuner.playTone(targetFreq());
    renderListening();   // sinon l'écran garde l'ancienne fréquence
  }
}

el.a4Range.addEventListener('input', (e) => setA4(Number(e.target.value)));
el.a4Minus.addEventListener('click', () => setA4(settings.a4 - 1));
el.a4Plus.addEventListener('click', () => setA4(settings.a4 + 1));

el.strictChk.addEventListener('change', (e) => {
  settings.strict = e.target.checked;
  saveSettings();
  drawGreenZone();
  toast(settings.strict ? 'Mode strict : ±2 cents' : 'Tolérance : ±5 cents');
});

el.hapticChk.addEventListener('change', (e) => {
  settings.haptic = e.target.checked;
  saveSettings();
});

el.metroBtn.addEventListener('click', () => showView('metro'));
el.backBtn.addEventListener('click', () => showView('tuner'));
el.playBtn.addEventListener('click', toggleMetronome);
el.tapBtn.addEventListener('click', tapTempo);
el.bpmRange.addEventListener('input', (e) => setTempo(Number(e.target.value)));
el.bpmMinus.addEventListener('click', () => setTempo(settings.bpm - 1));
el.bpmPlus.addEventListener('click', () => setTempo(settings.bpm + 1));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Seulement si une note joue : stopTone() rouvrirait sinon le micro en
    // arrière-plan, y compris depuis le métronome qui l'avait fermé exprès.
    stopToneUI().catch((err) => {
      toast(`Micro indisponible : ${err.message}`);
      stopMic();
    });
    if (metronome.isRunning()) toggleMetronome();
  } else {
    syncWakeLock();
  }
});

/* ------------------------------------------------------------ démarrage */

buildGauge();
buildStrings();
buildTuningList();
buildResponsePicker();
// une seule source pour les bornes : le moteur
el.bpmRange.min = String(MIN_BPM);
el.bpmRange.max = String(MAX_BPM);
metronome.setTempo(settings.bpm);
metronome.setBeatsPerBar(settings.beatsPerBar);
buildSignatures();
buildBeats();
renderTempo();
el.a4Value.textContent = `${settings.a4} Hz`;
el.a4Range.value = String(settings.a4);
el.strictChk.checked = settings.strict;
el.hapticChk.checked = settings.haptic;
setMode(settings.auto, { silent: true });
drawGreenZone();
renderIdle();

if (!window.isSecureContext) {
  el.gateNote.textContent = 'Le micro exige HTTPS (ou localhost). Ouvre la page en https://';
}

if ('serviceWorker' in navigator) {
  // Le service worker sert d'abord la version en cache, puis télécharge la
  // nouvelle en fond : sans ça, il faut relancer deux fois pour voir une mise
  // à jour. Quand la nouvelle version a pris la main, on propose de recharger.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // première installation : rien de neuf à montrer
    toast('Nouvelle version prête — touche ici pour recharger', {
      action: () => location.reload(),
    });
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* hors-ligne indisponible : l'accordeur fonctionne quand même */
    });
  });
}
