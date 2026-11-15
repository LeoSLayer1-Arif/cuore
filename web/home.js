// CUORE homepage: progressive enhancement only. The page reads fully without it.
"use strict";

document.documentElement.classList.add("js");

document.addEventListener("DOMContentLoaded", () => {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NS = "http://www.w3.org/2000/svg";

  // Hero instrument: 72 ticks and an illustrative pulse waveform around the heart.
  // It is decoration for the page (labelled "Illustration"), not a reading.
  const ticks = document.getElementById("hero-ticks");
  if (ticks) {   // homepage only
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2 - Math.PI / 2, major = i % 6 === 0, r1 = major ? 186 : 190;
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", 200 + r1 * Math.cos(a)); l.setAttribute("y1", 200 + r1 * Math.sin(a));
      l.setAttribute("x2", 200 + 196 * Math.cos(a)); l.setAttribute("y2", 200 + 196 * Math.sin(a));
      if (major) l.setAttribute("class", "major");
      ticks.appendChild(l);
    }
    const n = 180, beats = 7;
    const pulse = (p) => { const x = p % 1; return Math.exp(-((x - 0.18) ** 2) / 0.004) - 0.35 * Math.exp(-((x - 0.42) ** 2) / 0.01) + 0.25 * Math.exp(-((x - 0.55) ** 2) / 0.006); };
    const d = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2, r = 168 + pulse((i / n) * beats) * 12;
      return `${i ? "L" : "M"}${(200 + r * Math.cos(a)).toFixed(1)},${(200 + r * Math.sin(a)).toFixed(1)}`;
    }).join(" ") + " Z";
    const trace = document.getElementById("hero-trace");
    trace.setAttribute("d", d);
    trace.style.setProperty("--len", Math.ceil(trace.getTotalLength()));
    setTimeout(() => document.querySelector(".hero-fig").classList.add("ready"), 50);
  }

  // Nav: background once scrolled; underline the section in view.
  const nav = document.getElementById("nav");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  const links = [...document.querySelectorAll("[data-nav]")];
  if ("IntersectionObserver" in window) {
    // every section is watched: one without a nav link clears the underline
    const spy = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links) a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id);
      }
    }, { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("main > section").forEach((t) => spy.observe(t));
  }

  // Mobile menu: closes on a pick, Escape, or a tap outside.
  const menu = document.querySelector(".menu");
  menu.addEventListener("click", (e) => { if (e.target.closest("a")) menu.open = false; });
  document.addEventListener("click", (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { menu.open = false; menu.querySelector("summary").focus(); } });

  // Reveal each block once as it scrolls in (skipped with reduced motion).
  const blocks = document.querySelectorAll(".sec-head, .journey, .pipe, .meas, .base-grid > div, .base-fig, .states, .cant, .sci, .priv, .shots, .faq");
  if (reduce || !("IntersectionObserver" in window)) { blocks.forEach((b) => b.classList.add("in")); return; }
  blocks.forEach((b) => b.classList.add("reveal"));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { threshold: 0.08, rootMargin: "0px 0px -6% 0px" });
  blocks.forEach((b) => io.observe(b));
  // the baseline figure's line draws in with its section
  const bf = document.querySelector(".base-fig");
  if (bf) new IntersectionObserver((es, o) => { if (es[0].isIntersecting) { bf.classList.add("in"); o.disconnect(); } }, { threshold: 0.3 }).observe(bf);
});
