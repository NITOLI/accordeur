// Interface de l'accordeur : cadran, cordes, réglages, note de référence.

import { createTuner } from './tuner.js';
import { smoothFrequencies } from './pitch.js';
import { centsBetween, midiToFreq, midiToNote, nearestNote } from './notes.js';
import { TUNINGS, DEFAULT_TUNING_ID, getTuning, tuningStrings, tuningSummary } from './tunings.js';

/* ---------------------------------------------------------------- réglages */

const STORE_KEY = 'accordeur.settings.v1';

const settings = Object.assign(
  { tuningId: DEFAULT_TUNING_ID, a4: 440, strict: false, haptic: true, auto: true },
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

const HISTORY = 5;              // trames lissées ensemble
const SILENCE_FRAMES = 7;       // ~315 ms sans note -> retour au repos
const HOLD_TUNED_MS = 350;      // durée dans la zone juste pour valider
const HOLD_UNTUNED_MS = 700;    // durée hors zone pour invalider
const SWITCH_FRAMES = 3;        // trames avant de changer de corde en auto
const CLARITY_TUNED = 0.7;      // périodicité minimale pour valider une corde

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
  settingsBtn: document.getElementById('settingsBtn'),
  settingsDlg: document.getElementById('settingsDlg'),
  a4Value: document.getElementById('a4Value'),
  a4Range: document.getElementById('a4Range'),
  a4Minus: document.getElementById('a4Minus'),
  a4Plus: document.getElementById('a4Plus'),
  strictChk: document.getElementById('strictChk'),
  hapticChk: document.getElementById('hapticChk'),
  modeBtn: document.getElementById('modeBtn'),
  modeLabel: document.getElementById('modeLabel'),
  micBtn: document.getElementById('micBtn'),
  toneBtn: document.getElementById('toneBtn'),
  gate: document.getElementById('gate'),
  gateBtn: document.getElementById('gateBtn'),
  gateNote: document.getElementById('gateNote'),
  toast: document.getElementById('toast'),
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
      resetDetection();
      toast(`Accordage : ${t.name}`);
    });
    frag.appendChild(btn);
  });
  el.tuningList.replaceChildren(frag);
}

/* -------------------------------------------------------------- rendu live */

function targetFreq(index = state.targetIndex) {
  return midiToFreq(state.strings[index].midi, settings.a4);
}

function renderStrings() {
  el.strings.querySelectorAll('.string').forEach((btn) => {
    const i = Number(btn.dataset.index);
    btn.dataset.state = state.tuned.has(i) ? 'tuned' : i === state.targetIndex ? 'active' : 'idle';
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

function setNeedle(cents, cls) {
  const clamped = Math.max(-MAX_CENTS, Math.min(MAX_CENTS, cents));
  const angle = (clamped / MAX_CENTS) * MAX_ANGLE;
  el.needle.setAttribute('transform', `rotate(${angle.toFixed(2)} ${CENTER.x} ${CENTER.y})`);
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
  el.cents.textContent = tuner.isRunning() ? 'Joue une corde' : 'Micro en pause';
  el.freq.innerHTML = '&nbsp;';
  if (!tuner.isRunning()) {
    setAdvice('Active le micro pour commencer.');
  } else if (state.tuned.size === state.strings.length) {
    setAdvice('Les six cordes sont justes. Vérifie avec un accord.', true);
  } else {
    const next = nextStringNumber();
    setAdvice(`Joue la <b>corde ${next}</b> à vide, une seule à la fois.`);
  }
}

function render(freq, cents, clarity) {
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
    el.cents.textContent = `${arrow} · ${cents > 0 ? '+' : ''}${cents.toFixed(1)} cents`;
  }

  const [advice, ok] = adviceFor(cents);
  setAdvice(advice, ok);

  const heard = nearestNote(freq, settings.a4);
  const heardNote = midiToNote(heard.midi);
  el.freq.textContent = `${freq.toFixed(2)} Hz — entendu : ${heardNote.name}${heardNote.octave}`;
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
  if (tuner.isTonePlaying()) tuner.playTone(targetFreq());
  if (state.idle) renderIdle();
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

  if (!freq) {
    if (++state.silence >= SILENCE_FRAMES && !state.idle) renderIdle();
    return;
  }
  state.silence = 0;
  state.idle = false;

  state.history.push(freq);
  if (state.history.length > HISTORY) state.history.shift();
  const smooth = smoothFrequencies(state.history);

  if (settings.auto) pickString(smooth);

  const rawCents = centsBetween(smooth, targetFreq());
  // Lissage adaptatif : réactif quand on est loin, stable quand on est près.
  const alpha = Math.abs(rawCents - state.displayCents) > 25 ? 0.6 : 0.28;
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

  render(smooth, cents, clarity);
}

/* ------------------------------------------------------------------ micro */

const tuner = createTuner({
  onFrame,
  onError: (err) => toast(`Erreur audio : ${err.message}`),
});

let wakeLock = null;

async function requestWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) || null;
    wakeLock?.addEventListener('release', () => { wakeLock = null; });
  } catch {
    /* non disponible : sans conséquence pour l'accordage */
  }
}

async function startMic() {
  try {
    el.micBtn.disabled = true;
    await tuner.start();
    el.gate.hidden = true;
    el.micBtn.textContent = 'Couper le micro';
    el.micBtn.classList.add('is-on');
    resetDetection();
    requestWakeLock();
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    const msg = denied
      ? "Micro refusé. Autorise-le dans les réglages du navigateur, puis réessaie."
      : `Micro indisponible : ${err.message}`;
    el.gateNote.textContent = msg;
    toast(msg);
  } finally {
    el.micBtn.disabled = false;
  }
}

function stopMic() {
  tuner.stop();
  wakeLock?.release?.();
  wakeLock = null;
  el.micBtn.textContent = 'Activer le micro';
  el.micBtn.classList.remove('is-on');
  renderIdle();
}

/* ------------------------------------------------------------------ toast */

let toastTimer = 0;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

/* ------------------------------------------------------------- évènements */

el.gateBtn.addEventListener('click', startMic);
el.micBtn.addEventListener('click', () => (tuner.isRunning() ? stopMic() : startMic()));
el.modeBtn.addEventListener('click', () => setMode(!settings.auto));

el.toneBtn.addEventListener('click', () => {
  if (tuner.isTonePlaying()) {
    tuner.stopTone();
    el.toneBtn.setAttribute('aria-pressed', 'false');
  } else {
    tuner.playTone(targetFreq());
    el.toneBtn.setAttribute('aria-pressed', 'true');
    const s = state.strings[state.targetIndex];
    toast(`Note de référence : corde ${s.number}`);
  }
});

el.settingsBtn.addEventListener('click', () => el.settingsDlg.showModal());
el.tuningBtn.addEventListener('click', () => el.settingsDlg.showModal());

function setA4(value) {
  settings.a4 = Math.max(415, Math.min(465, Math.round(value)));
  saveSettings();
  el.a4Value.textContent = `${settings.a4} Hz`;
  el.a4Range.value = String(settings.a4);
  state.tuned.clear();
  renderStrings();
  renderTargetLine();
  if (tuner.isTonePlaying()) tuner.playTone(targetFreq());
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

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    tuner.stopTone();
    el.toneBtn.setAttribute('aria-pressed', 'false');
  } else if (tuner.isRunning() && !wakeLock) {
    requestWakeLock();
  }
});

/* ------------------------------------------------------------ démarrage */

buildGauge();
buildStrings();
buildTuningList();
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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* hors-ligne indisponible : l'accordeur fonctionne quand même */
    });
  });
}
