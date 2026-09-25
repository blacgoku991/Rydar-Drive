// Sons du dashboard, synthétisés (Web Audio) : aucun fichier, latence nulle.
// Les navigateurs bloquent l'audio avant la première interaction : unlockAudio() au premier clic.

export type SoundKind = "new" | "accepted" | "alert";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

export function unlockAudio() {
  const c = audio();
  if (c && c.state === "suspended") void c.resume();
}

function note(c: AudioContext, out: AudioNode, freq: number, at: number, dur: number, gain: number, type: OscillatorType = "sine") {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + dur + 0.05);
}

export function playSound(kind: SoundKind, volume = 1) {
  const c = audio();
  if (!c || c.state !== "running") return;
  const t = c.currentTime + 0.01;
  const master = c.createGain();
  master.gain.value = 0.9 * volume;
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 5200;
  master.connect(lp).connect(c.destination);

  if (kind === "new") {
    // Carillon montant : « nouvelle course »
    note(c, master, 880, t, 0.5, 0.22);
    note(c, master, 1760, t, 0.25, 0.04, "triangle");
    note(c, master, 1318.5, t + 0.14, 0.7, 0.22);
    note(c, master, 2637, t + 0.14, 0.3, 0.035, "triangle");
  } else if (kind === "accepted") {
    // Ding bref et doux : « attribuée »
    note(c, master, 1046.5, t, 0.35, 0.12);
    note(c, master, 1568, t + 0.05, 0.4, 0.09);
  } else {
    // Trois impulsions : « personne n'a pris la course »
    for (let i = 0; i < 3; i++) {
      note(c, master, 740, t + i * 0.2, 0.15, 0.16, "square");
      note(c, master, 1480, t + i * 0.2, 0.12, 0.04, "sine");
    }
  }
}
