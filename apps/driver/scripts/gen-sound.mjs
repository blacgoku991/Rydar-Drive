// Génère la sonnerie d'offre (carillon ascendant, 1,6 s) — WAV PCM 16 bits mono 44,1 kHz.
import { writeFileSync } from "node:fs";
const rate = 44100, dur = 1.6, n = Math.floor(rate * dur);
const notes = [[0, 880], [0.16, 1174.66], [0.32, 1567.98], [0.8, 880], [0.96, 1174.66], [1.12, 1567.98]];
const data = new Int16Array(n);
for (let i = 0; i < n; i++) {
  const t = i / rate;
  let v = 0;
  for (const [start, f] of notes) {
    const dt = t - start;
    if (dt < 0 || dt > 0.5) continue;
    const env = Math.min(1, dt / 0.005) * Math.exp(-dt * 7);
    v += env * (Math.sin(2 * Math.PI * f * dt) * 0.6 + Math.sin(2 * Math.PI * f * 2 * dt) * 0.18 + Math.sin(2 * Math.PI * f * 3 * dt) * 0.06);
  }
  data[i] = Math.max(-1, Math.min(1, v * 0.55)) * 32767;
}
const header = Buffer.alloc(44);
header.write("RIFF", 0); header.writeUInt32LE(36 + n * 2, 4); header.write("WAVE", 8);
header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write("data", 36); header.writeUInt32LE(n * 2, 40);
writeFileSync(new URL("../assets/sounds/ride_offer.wav", import.meta.url), Buffer.concat([header, Buffer.from(data.buffer)]));
console.log("ride_offer.wav ok");
