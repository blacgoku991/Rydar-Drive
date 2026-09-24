"""Règles partagées (tuiles + graphe routier) pour interpréter les segments Overture.

Overture transportation/segment :
- access_restrictions : [{access_type: allowed|denied|designated, when: {heading, mode[], using[],
  recognized[], during, vehicle[]}, between: [a, b] | null}]
  * sens unique  = {denied, when.heading = backward}  (interdit à contre-sens de la géométrie)
  * sens inverse = {denied, when.heading = forward}
  * access=no    = {denied} sans condition ; motor_vehicle=no = {denied, mode: [motor_vehicle]}
  * access=private = {allowed, recognized: [as_private]}
- road_flags : [{values: [is_bridge|is_tunnel|is_link|...], between}]
Les règles conditionnelles (horaires `during`, gabarits `vehicle`) sont ignorées.
"""
from __future__ import annotations

MOTOR_MODES = {"motor_vehicle", "car", "vehicle", "motorcar"}

# Classes routières carrossables et vitesses (km/h, profil urbain)
DRIVE_SPEEDS = {
    "motorway": 90,
    "trunk": 70,
    "primary": 40,
    "secondary": 35,
    "tertiary": 30,
    "unclassified": 30,
    "residential": 25,
    "living_street": 12,
    "service": 15,
}
LINK_SPEED = 45
LINK_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary"}


def car_rules(rules) -> list[tuple[float, float, str]]:
    """Réduit access_restrictions à une liste (a, b, kind) pertinente pour une voiture.

    kind ∈ deny | deny_fwd | deny_bwd | allow | private
    """
    out: list[tuple[float, float, str]] = []
    for r in rules or []:
        w = r.get("when") or {}
        a, b = r.get("between") or (0.0, 1.0)
        if w.get("during") or w.get("vehicle"):
            continue  # restriction conditionnelle (horaires, gabarit) : ignorée
        modes = set(w.get("mode") or [])
        if modes and not (modes & MOTOR_MODES):
            continue  # ne concerne pas les voitures (vélo, piéton, bus…)
        recognized = set(w.get("recognized") or [])
        heading = w.get("heading")
        if r.get("access_type") == "denied":
            if w.get("using") or recognized:
                continue
            if heading == "backward":
                out.append((a, b, "deny_bwd"))
            elif heading == "forward":
                out.append((a, b, "deny_fwd"))
            else:
                out.append((a, b, "deny"))
        else:  # allowed / designated
            if heading:
                continue
            if "as_private" in recognized:
                out.append((a, b, "private"))
            else:
                out.append((a, b, "allow"))
    return out


def car_access_at(rules: list[tuple[float, float, str]], t: float) -> tuple[bool, bool]:
    """(sens géométrie autorisé, contre-sens autorisé) à la position linéaire t ∈ [0,1]."""
    fwd = bwd = True
    deny = allow = private = False
    for a, b, k in rules:
        if not (a - 1e-9 <= t <= b + 1e-9):
            continue
        if k == "deny":
            deny = True
        elif k == "allow":
            allow = True
        elif k == "private":
            private = True
        elif k == "deny_bwd":
            bwd = False
        elif k == "deny_fwd":
            fwd = False
    if (deny or private) and not allow:
        return False, False
    return fwd, bwd


def oneway_flag(rules) -> int:
    """Attribut OpenMapTiles `oneway` : 1 (sens géométrie), -1 (sens inverse), 0."""
    cr = car_rules(rules)
    f, b = car_access_at(cr, 0.5)
    if f and not b:
        return 1
    if b and not f:
        return -1
    return 0


def flag_values(flags, name: str) -> list[tuple[float, float]] | None:
    """Plages [a, b] où le drapeau `name` (is_bridge, is_link…) s'applique ; None si jamais."""
    out = []
    for f in flags or []:
        if name in (f.get("values") or []):
            out.append(tuple(f.get("between") or (0.0, 1.0)))
    return out or None


def is_link(subclass, flags) -> bool:
    if subclass == "link":
        return True
    rng = flag_values(flags, "is_link")
    return bool(rng and any(b - a > 0.5 for a, b in rng))


def max_speed_at(limits, t: float) -> float | None:
    """Vitesse maximale légale (km/h) à la position t, si renseignée sans condition.

    Les limitations conditionnelles (horaires, véhicules, modes) sont ignorées ; une limite
    propre à un sens (heading) est prise en compte de façon conservative (min des deux sens).
    """
    best = None
    for s in limits or []:
        ms = s.get("max_speed")
        if not ms or not ms.get("value"):
            continue
        w = s.get("when") or {}
        if w.get("during") or w.get("vehicle") or w.get("mode") or w.get("using") or w.get("recognized"):
            continue
        a, b = s.get("between") or (0.0, 1.0)
        if not (a - 1e-9 <= t <= b + 1e-9):
            continue
        v = float(ms["value"]) * (1.609344 if (ms.get("unit") or "km/h") == "mph" else 1.0)
        best = v if best is None else min(best, v)
    return best
