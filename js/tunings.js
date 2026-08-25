// Accordages, des graves vers les aigus (corde 6 -> corde 1).
// Les valeurs sont des numéros de note MIDI : 40 = E2 (mi grave).

import { midiToLabel } from './notes.js';

export const TUNINGS = [
  { id: 'standard',  name: 'Standard',        notes: [40, 45, 50, 55, 59, 64] },
  { id: 'drop-d',    name: 'Drop D',          notes: [38, 45, 50, 55, 59, 64] },
  { id: 'half-down', name: 'Demi-ton en bas', notes: [39, 44, 49, 54, 58, 63] },
  { id: 'full-down', name: 'Un ton en bas',   notes: [38, 43, 48, 53, 57, 62] },
  { id: 'drop-c',    name: 'Drop C',          notes: [36, 43, 48, 53, 57, 62] },
  { id: 'open-d',    name: 'Open D',          notes: [38, 45, 50, 54, 57, 62] },
  { id: 'open-g',    name: 'Open G',          notes: [38, 43, 50, 55, 59, 62] },
  { id: 'dadgad',    name: 'DADGAD',          notes: [38, 45, 50, 55, 57, 62] },
];

export const DEFAULT_TUNING_ID = 'standard';

export function getTuning(id) {
  return TUNINGS.find((t) => t.id === id) || TUNINGS[0];
}

/** Résumé d'un accordage, ex. 'E A D G B E'. */
export function tuningSummary(tuning) {
  return tuning.notes.map((m) => midiToLabel(m).replace(/\d+$/, '')).join(' ');
}

/** Cordes d'un accordage, numérotées comme les guitaristes (6 = la plus grave). */
export function tuningStrings(tuning) {
  const n = tuning.notes.length;
  return tuning.notes.map((midi, i) => ({
    index: i,
    number: n - i,
    midi,
    label: midiToLabel(midi),
  }));
}
