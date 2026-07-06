// Sound effects for Oracle Office

// Audio context — unlocked by user interaction
let audioCtx: AudioContext | null = null;
let unlocked = false;

/** Generate a short tick sound via Web Audio API */
function playTick() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.frequency.value = 1200;
  osc.type = "sine";
  gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.08);
}

/** Unlock audio on first user click/tap — plays a small tick so human knows sound is on */
export function unlockAudio() {
  if (unlocked) return;
  try {
    audioCtx = new AudioContext();
    // Resume if suspended (browser autoplay policy)
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    playTick();
    unlocked = true;
  } catch {}
}

/** Check if audio has been unlocked */
export function isAudioUnlocked() {
  return unlocked;
}

/** Set by store — checked before playing sounds */
let _muted = false;
export function setSoundMuted(m: boolean) { _muted = m; }
export function isSoundMuted() { return _muted; }

const saiyanSounds = ["/office/saiyan.mp3", "/office/saiyan-aura.mp3", "/office/saiyan-rose.mp3", "/office/saiyan-2.mp3"];
const SAIYAN_MAX_PLAY = 3; // seconds before fade-out
const SAIYAN_FADE_MS = 1500;

/** Play a random saiyan sound with auto fade-out */
export function playSaiyanSound() {
  if (!unlocked || _muted) return;
  try {
    const src = saiyanSounds[Math.floor(Math.random() * saiyanSounds.length)];
    const audio = new Audio(src);
    audio.volume = 0.3;
    audio.play().catch(() => {});
    setTimeout(() => {
      const startVol = audio.volume;
      const steps = 30;
      const stepMs = SAIYAN_FADE_MS / steps;
      let step = 0;
      const fade = setInterval(() => {
        step++;
        audio.volume = Math.max(0, startVol * (1 - step / steps));
        if (step >= steps) { clearInterval(fade); audio.pause(); }
      }, stepMs);
    }, SAIYAN_MAX_PLAY * 1000);
  } catch {}
}

