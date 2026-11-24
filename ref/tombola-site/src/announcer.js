// The tannoy: a loudspeaker in the corner that shouts a line from the bank every 10 to 15 seconds, and on every event
// the drum reports (buy, sell, winner). Live numbers are read off the page, so nothing here touches main.js.
import { LINES, CLEAN, makePicker, lastPicked, hashLine } from "./lines.js";
import { VOICED } from "./generated/voice.js";

const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initAnnouncer(host, { voice = "crude", ticker = "TOMBOLA", isLive = () => true, music = null } = {}) {
  if (!host) return null;
  // the spoken line: one clip at a time, the music ducked underneath, nothing if the speaker is muted
  let clip = null;
  function speak(raw, onEnd) {
    const h = hashLine(raw);
    if (!VOICED.has(h) || (music && !music.on) || typeof Audio !== "function") return false;
    if (clip) { clip.pause(); clip = null; }
    const a = new Audio(`audio/lines/${h}.mp3`);
    a.volume = 1;
    clip = a;
    const done = () => { if (clip === a) { clip = null; music?.duck?.(false); onEnd?.(); } };
    a.addEventListener("ended", done); a.addEventListener("error", done);
    music?.duck?.(true);
    a.play().catch(done);
    return true;
  }
  const pick = makePicker(voice === "clean" ? CLEAN : LINES);
  const bubble = host.querySelector(".tannoy-bubble");
  const text = host.querySelector(".tannoy-text");
  let hideTimer = 0, nextTimer = 0, paused = true;

  const $ = (id) => document.getElementById(id);
  const num = (s) => (s || "").replace(/[^\d.]/g, "");
  // Live values read off the page. Anything not actually known is left undefined, and the picker then skips
  // every line that needs it, so the tannoy never shouts a made-up number or time.
  function vars() {
    const cd = $("regular-cd");
    const hT = cd?.querySelector("[data-h]")?.textContent ?? "", mT = cd?.querySelector("[data-m]")?.textContent ?? "";
    const known = /^\d+$/.test(hT) && /^\d+$/.test(mT) && !$("pot-board")?.hidden;
    const mins = known ? Number(hT) * 60 + Number(mT) : undefined;
    const time = mins === undefined ? undefined : mins === 0 ? "under a minute" : mins < 60 ? `${mins} minute${mins === 1 ? "" : "s"}` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
    const walletsText = $("plate-wallets")?.textContent || $("in-drum")?.textContent || "";
    const w = num(walletsText.split(" ")[0]) || num(walletsText);
    const potT = $("pot-eth")?.dataset.eth || $("pot-eth")?.textContent?.trim();
    return {
      pot: known && potT ? potT : undefined,
      wallets: w ? Number(w).toLocaleString() : undefined,
      mins: mins !== undefined && mins > 0 && mins <= 10 ? mins : undefined, // only the countdown kind uses it
      time, ticker, _mins: mins,
    };
  }

  function say(kind, extra = {}, hold = 9000) {
    const v = { ...vars(), ...extra };
    let line = pick(kind, v);
    if (!line) return;
    text.textContent = line;
    host.classList.add("on");
    host.classList.remove("pop"); void host.offsetWidth; host.classList.add("pop");
    clearTimeout(hideTimer);
    // spoken: the bubble stays up until the clip ends (plus a beat); silent: the usual hold
    const spoken = speak(lastPicked(), () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 1500); });
    hideTimer = setTimeout(hide, spoken ? 30000 : hold);
  }
  function hide() { host.classList.remove("on"); }

  function schedule() {
    clearTimeout(nextTimer);
    const wait = reduced ? 30000 : 10000 + Math.random() * 5000;
    nextTimer = setTimeout(() => {
      if (!paused && !document.hidden) {
        const v = vars();
        const live = isLive();
        const kind = !live ? "soon" : v._mins !== undefined && v._mins > 0 && v._mins <= 10 ? "countdown" : "idle";
        say(kind);
      }
      schedule();
    }, wait);
  }

  const shutUp = () => { hide(); if (clip) { clip.pause(); clip = null; music?.duck?.(false); } };
  host.querySelector(".tannoy-close")?.addEventListener("click", shutUp);
  bubble?.addEventListener("click", shutUp);
  document.addEventListener("visibilitychange", () => { if (document.hidden) shutUp(); });

  return {
    /** Lets the tannoy start shouting (after the curtain opens). First line soon after. */
    start() { if (!paused) return; paused = false; setTimeout(() => { if (!paused) say(isLive() ? "idle" : "soon"); }, 2500); schedule(); },
    stop() { paused = true; clearTimeout(nextTimer); shutUp(); },
    say,
    /** Speaks a raw line (no bubble), e.g. the curtain greeting. */
    speak: (raw) => speak(raw),
    event(kind, extra) { if (paused) return; if (kind === "buy" || kind === "sell") { if (Math.random() < 0.35) say(kind, extra, 6000); } else say(kind, extra, 14000); },
  };
}
