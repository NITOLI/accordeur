// Conversions note <-> fréquence. Aucune dépendance au DOM (testable sous Node).

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Fréquence d'un numéro de note MIDI (69 = La3 du diapason). */
export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/** Numéro MIDI fractionnaire correspondant à une fréquence. */
export function freqToMidi(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

/** Écart en cents entre une fréquence et une fréquence de référence. */
export function centsBetween(freq, refFreq) {
  return 1200 * Math.log2(freq / refFreq);
}

/** Nom scientifique d'une note MIDI, ex. 40 -> { name: 'E', octave: 2 }. */
export function midiToNote(midi) {
  const m = Math.round(midi);
  return { name: NOTE_NAMES[((m % 12) + 12) % 12], octave: Math.floor(m / 12) - 1 };
}

/** Étiquette lisible d'une note MIDI, ex. 40 -> 'E2'. */
export function midiToLabel(midi) {
  const { name, octave } = midiToNote(midi);
  return `${name}${octave}`;
}

/** Note MIDI la plus proche d'une fréquence + écart en cents. */
export function nearestNote(freq, a4 = 440) {
  const midi = Math.round(freqToMidi(freq, a4));
  return { midi, cents: centsBetween(freq, midiToFreq(midi, a4)) };
}
