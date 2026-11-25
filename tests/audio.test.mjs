// Courses et garde-fous du métronome et du tuner, avec un AudioContext factice.
// Lancement : node tests/audio.test.mjs
import { createMetronome } from '../js/metronome.js';
import { createTuner } from '../js/tuner.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- doubles ---------------------------------------------------------------

globalThis.window = globalThis;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

function node() {
  return {
    connect() {}, disconnect() {}, start() {}, stop() {},
    gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} },
    frequency: { value: 0, setValueAtTime() {}, setTargetAtTime() {} },
    Q: { value: 0 },
    getFloatTimeDomainData(buf) { buf.fill(0); },
  };
}

function fakeContext({ resumeDelay = 20 } = {}) {
  const stats = { oscillators: 0 };
  const ctx = {
    stats,
    sampleRate: 48000,
    destination: node(),
    get currentTime() { return performance.now() / 1000; },
    resume: () => sleep(resumeDelay),
    createGain: node,
    createOscillator() { stats.oscillators++; return node(); },
    createBiquadFilter: node,
    createAnalyser: node,
    createMediaStreamSource: node,
  };
  return ctx;
}

// --- métronome -------------------------------------------------------------

console.log('— métronome —');
{
  const ctx = fakeContext();
  const metro = createMetronome({ context: () => ctx, onBeat: () => {} });
  metro.setTempo(250);
  await Promise.all([metro.start(), metro.start()]);   // double tap
  await sleep(700);
  metro.stop();
  const atStop = ctx.stats.oscillators;
  await sleep(600);
  check('double start puis stop : plus aucun clic après l\'arrêt',
    ctx.stats.oscillators === atStop, `${atStop} -> ${ctx.stats.oscillators} oscillateurs`);
  check('isRunning() faux après stop', !metro.isRunning());
}
{
  const ctx = fakeContext({ resumeDelay: 60 });
  const metro = createMetronome({ context: () => ctx, onBeat: () => {} });
  const starting = metro.start();
  metro.stop();                                   // arrêt pendant l'attente
  await starting;
  await sleep(150);
  check('stop() pendant resume() : le métronome ne démarre pas',
    !metro.isRunning() && ctx.stats.oscillators === 0, `${ctx.stats.oscillators} oscillateurs`);
}
{
  const ctx = fakeContext();
  const metro = createMetronome({ context: () => ctx });   // sans onBeat
  let finished = false;
  const run = (async () => { await metro.start(); await sleep(400); metro.stop(); finished = true; })();
  await Promise.race([run, sleep(2000)]);
  check('sans onBeat : la boucle visuelle ne bloque pas', finished);
}

// --- tuner -----------------------------------------------------------------

console.log('\n— tuner —');
function setupTuner() {
  const ctx = fakeContext();
  const streams = [];
  globalThis.AudioContext = function () { return ctx; };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia() {
          await sleep(30);
          const stream = { live: true, getTracks() { return [{ stop: () => { stream.live = false; } }]; } };
          streams.push(stream);
          return stream;
        },
      },
    },
  });
  return { ctx, streams, tuner: createTuner({ onFrame() {}, onError() {} }) };
}

{
  const { streams, tuner } = setupTuner();
  await Promise.all([tuner.start(), tuner.start()]);   // double tap sur « Autoriser le micro »
  tuner.stop();
  check('deux start() : aucun flux micro laissé ouvert après stop()',
    streams.every((s) => !s.live), `${streams.length} flux ouverts, ${streams.filter((s) => s.live).length} vivants`);
}
{
  const { streams, tuner } = setupTuner();
  await tuner.start();
  const pending = tuner.resumeAfterPlayback();
  await tuner.suspendForPlayback();                     // note ou métronome pendant l'ouverture
  await pending;
  check('suspendForPlayback() : micro fermé et aucun flux vivant',
    !tuner.isRunning() && streams.every((s) => !s.live));
}
{
  const { streams, tuner } = setupTuner();
  const opening = tuner.start();
  await sleep(5);
  await tuner.suspendForPlayback();                     // pendant getUserMedia
  await opening;
  check('suspension pendant l\'ouverture : le micro ne s\'ouvre pas quand même',
    !tuner.isRunning() && streams.every((s) => !s.live));
  await tuner.resumeAfterPlayback();
  check('retour de la suspension : le micro rouvre', tuner.isRunning() && streams.filter((s) => s.live).length === 1);
  tuner.stop();
}
{
  const { streams, tuner } = setupTuner();
  await tuner.playTone(82.41);
  await tuner.start();                                  // micro demandé pendant la note
  check('start() pendant la note : la note est coupée', !tuner.isTonePlaying());
  check('start() pendant la note : le micro est ouvert', tuner.isRunning() && streams.filter((s) => s.live).length === 1);
  tuner.stop();
}
{
  const { tuner } = setupTuner();
  await tuner.start();
  await tuner.suspendForPlayback();                     // vue métronome, micro fermé
  await tuner.stopTone();                               // sans note : ne doit pas rouvrir le micro ?
  check('stopTone() sans note rend le micro (comportement documenté)', tuner.isRunning());
  await tuner.suspendForPlayback();
  await tuner.playTone(110);
  await tuner.stopTone({ resume: false });
  check('stopTone({resume:false}) laisse le micro fermé', !tuner.isRunning() && !tuner.isTonePlaying());
  tuner.stop();
}

console.log(`\n${failures === 0 ? 'Tous les tests passent.' : failures + ' test(s) en échec.'}`);
process.exit(failures === 0 ? 0 : 1);
