// The curtain: red velvet drawn shut over the page on arrival, a rude welcome, and one button. The click parts the
// curtains and, being a real gesture, lets the music start (src/music.js listens for it). Shown once per tab session.
import { LINES, CLEAN } from "./lines.js";
const KEY = "tombola-curtain";
const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initCurtain(el, { onOpen, voice = "crude" } = {}) {
  if (!el) return null;
  let seen = false;
  try { seen = sessionStorage.getItem(KEY) === "open"; } catch { /* storage blocked */ }
  if (seen) { el.remove(); return null; }

  const bank = (voice === "clean" ? CLEAN : LINES).curtain;
  const [head, sub] = bank[Math.floor(Math.random() * bank.length)];
  el.querySelector("#curtain-head").textContent = head;
  el.querySelector("#curtain-sub").textContent = sub;
  el.hidden = false;
  document.body.classList.add("curtain-shut");

  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    el.classList.add("open");
    document.body.classList.remove("curtain-shut");
    try { sessionStorage.setItem(KEY, "open"); } catch { /* storage blocked */ }
    onOpen?.(`${head} ${sub}`);
    setTimeout(() => el.remove(), reduced ? 0 : 2400);
  };
  const btn = el.querySelector("#curtain-btn");
  btn.addEventListener("click", open);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") open(); });
  setTimeout(() => btn.focus({ preventScroll: true }), 50);
  return { open };
}
