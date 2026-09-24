// Marqueurs HTML de la carte (véhicules, départ, arrivée) — styles dans globals.css (.rd-car, .rd-stop).

export function carElement() {
  const el = document.createElement("div");
  el.className = "rd-car";
  el.innerHTML = '<span class="rd-car__pulse"></span><span class="rd-car__dir"></span><span class="rd-car__body"><span class="rd-car__txt"></span></span><span class="rd-car__label"></span>';
  return el;
}

export function updateCar(
  el: HTMLElement,
  s: { color: string; heading: number | null; moving: boolean; initials: string; label: string; selected: boolean; pulse: boolean; dim: boolean },
) {
  el.style.setProperty("--c", s.color);
  el.style.setProperty("--h", `${s.heading ?? 0}deg`);
  el.dataset.moving = String(s.moving && s.heading != null);
  el.dataset.selected = String(s.selected);
  el.dataset.pulse = String(s.pulse);
  el.dataset.dim = String(s.dim);
  const txt = el.querySelector(".rd-car__txt");
  if (txt && txt.textContent !== s.initials) txt.textContent = s.initials;
  const label = el.querySelector(".rd-car__label");
  if (label && label.textContent !== s.label) label.textContent = s.label;
}

export function stopElement(kind: "start" | "end", label = "") {
  const el = document.createElement("div");
  el.className = `rd-stop rd-stop--${kind}`;
  el.innerHTML = `<span class="rd-stop__pulse"></span><span class="rd-stop__dot"></span>${label ? `<span class="rd-stop__label">${label}</span>` : ""}`;
  return el;
}
