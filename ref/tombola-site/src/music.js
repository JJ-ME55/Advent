// Fairground music, on by default: the two circus tracks loop in turn. Browsers refuse sound before a gesture, so
// playback starts on the visitor's first tap, click, key or scroll (an immediate attempt is made too, which works
// for visitors the browser already trusts). The speaker on the sign mutes it; that choice is remembered per visitor.
const TRACKS = ["audio/circus-1.mp3", "audio/circus-2.mp3"];
const KEY = "tombola-music";
const VOLUME = 0.35;

export function initMusic(btn) {
  if (!btn || typeof Audio !== "function") return null;
  let audio = null, i = Math.floor(Math.random() * TRACKS.length);
  const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const store = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode, blocked storage */ } };
  let wanted = stored() !== "off"; // on unless this visitor muted it before
  let playing = false;

  function ensure() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "auto";
    audio.volume = VOLUME;
    audio.src = TRACKS[i];
    const next = () => { i = (i + 1) % TRACKS.length; audio.src = TRACKS[i]; if (wanted) audio.play().catch(() => {}); };
    audio.addEventListener("ended", next);
    audio.addEventListener("error", next);
    audio.addEventListener("playing", () => { playing = true; render(); });
    audio.addEventListener("pause", () => { playing = false; render(); });
    return audio;
  }
  function render() {
    btn.setAttribute("aria-pressed", wanted ? "true" : "false");
    btn.title = wanted ? "Mute the music" : "Music on";
    btn.classList.toggle("is-on", wanted);
    btn.classList.toggle("is-playing", wanted && playing);
  }
  function tryPlay() { if (!wanted) return; ensure().play().catch(() => {}); }
  let ducked = false;
  function duck(on) { ducked = on; if (audio) audio.volume = on ? VOLUME * 0.3 : VOLUME; }
  function mute() { wanted = false; store("off"); audio?.pause(); render(); }
  function unmute() { wanted = true; store("on"); tryPlay(); render(); }
  btn.addEventListener("click", (e) => { e.stopPropagation(); wanted ? mute() : unmute(); });
  render();

  // first gesture anywhere starts it (listeners stay until it is actually playing)
  const gestures = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"];
  const onGesture = () => { if (playing || !wanted) { if (playing) off(); return; } tryPlay(); };
  const off = () => { for (const ev of gestures) document.removeEventListener(ev, onGesture, true); };
  for (const ev of gestures) document.addEventListener(ev, onGesture, { capture: true, passive: true });
  tryPlay(); // works straight away for visitors the browser already trusts

  // pause when the tab is hidden, resume when it's back
  document.addEventListener("visibilitychange", () => { if (!audio || !wanted) return; if (document.hidden) audio.pause(); else audio.play().catch(() => {}); });
  return { mute, unmute, start: tryPlay, duck, get on() { return wanted; }, get ducked() { return ducked; } };
}
