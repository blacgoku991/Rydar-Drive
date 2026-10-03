"use client";

import { Pause, Play } from "lucide-react";
import dynamic from "next/dynamic";
import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// three.js n'est téléchargé que sur un ordinateur bien équipé (liveGlobeSnapshot), une fois la page chargée et le
// navigateur au repos (useAfterLoad). Partout ailleurs : l'image du globe, sans script ni calcul 3D.
const GlobeScene = dynamic(() => import("./globe-scene"), { ssr: false });

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const reducedMotionSnapshot = () => window.matchMedia(REDUCED_MOTION).matches;

/** WebGL 2 disponible (three.js ≥ r163 ne gère plus WebGL 1). Contexte de test libéré aussitôt. */
function hasWebgl2() {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

type NavigatorHints = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean; effectiveType?: string } };

let live: boolean | undefined;
/**
 * Globe animé (three.js) seulement sur un ordinateur bien équipé : souris, 8 cœurs ou plus, 8 Go de mémoire ou plus
 * (quand le navigateur l'indique), ni économie de données ni réseau lent, WebGL 2. Mesuré (Lighthouse, mobile) : la
 * scène 3D bloque le téléphone environ 3 s ; l'image du globe, rien.
 */
function liveGlobeSnapshot() {
  if (live === undefined) {
    const nav = navigator as NavigatorHints;
    live =
      window.matchMedia("(pointer: fine) and (hover: hover)").matches &&
      (nav.hardwareConcurrency || 0) >= 8 &&
      (nav.deviceMemory === undefined || nav.deviceMemory >= 8) &&
      !nav.connection?.saveData &&
      !/2g|3g/.test(nav.connection?.effectiveType || "") &&
      hasWebgl2();
  }
  return live;
}
const subscribeNever = () => () => {};

/**
 * true une fois la page chargée et le navigateur au repos (2,5 s au plus après le chargement) : three.js et la
 * construction de la scène ne retardent ni l'affichage ni les premiers gestes.
 */
function useAfterLoad(enabled: boolean) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!enabled || done) return;
    let cancel = () => {};
    const go = () => setDone(true);
    const schedule = () => {
      // Safari n'a pas requestIdleCallback : court délai après le chargement
      const idle = (window as Partial<Window>).requestIdleCallback;
      if (idle) {
        const id = idle.call(window, go, { timeout: 2500 });
        cancel = () => window.cancelIdleCallback(id);
      } else {
        const id = window.setTimeout(go, 600);
        cancel = () => window.clearTimeout(id);
      }
    };
    if (document.readyState === "complete") schedule();
    else {
      window.addEventListener("load", schedule, { once: true });
      cancel = () => window.removeEventListener("load", schedule);
    }
    return () => cancel();
  }, [enabled, done]);
  return done;
}

/**
 * Frontière d'erreur du globe : module three.js introuvable (réseau instable, page servie par l'ancienne version
 * pendant une mise à jour) ou erreur de la scène. Sans elle, l'erreur remonterait jusqu'à l'écran d'erreur de Next,
 * qui remplacerait toute la page ; ici, l'image du globe reste affichée.
 */
class GlobeBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    this.props.onError();
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Image du globe (rendu de la scène 3D, fond transparent) : AVIF, sinon WebP ; 640, 960 ou 1200 px selon l'écran. */
function GlobeImage({ hidden }: { hidden: boolean }) {
  const set = (ext: string) => [640, 960, 1200].map((w) => `/marketing/globe-${w}.${ext} ${w}w`).join(", ");
  const sizes = "(min-width: 1024px) 600px, 92vw";
  return (
    <picture>
      <source type="image/avif" srcSet={set("avif")} sizes={sizes} />
      <source type="image/webp" srcSet={set("webp")} sizes={sizes} />
      <img
        src="/marketing/globe-960.webp"
        alt=""
        width={1200}
        height={1200}
        // Plus grand élément du haut de page (LCP) : téléchargé en priorité
        fetchPriority="high"
        className={cn(
          "absolute inset-0 size-full select-none transition-opacity duration-700 ease-out motion-reduce:transition-none",
          hidden && "opacity-0",
        )}
      />
    </picture>
  );
}

/**
 * Visuel du héro : image du globe (radar de dispatch sur la France), servie avec la page. Sur un ordinateur bien
 * équipé, le globe animé (three.js) la remplace en fondu une fois la page chargée ; s'il ne se charge pas, échoue ou
 * perd son contexte, l'image reste. Pas d'animation si l'utilisateur en a demandé moins, ou après « Mettre en pause »
 * (animation continue : commande de pause obligatoire, WCAG 2.2.2 / RGAA 13.8).
 */
export function HeroVisual({ label, children, className }: { label: string; children?: ReactNode; className?: string }) {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
  const capable = useSyncExternalStore(subscribeNever, liveGlobeSnapshot, () => false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const animated = capable && !reducedMotion && !failed;
  const loaded = useAfterLoad(animated);
  const showLive = animated && loaded;

  return (
    <div className={cn("relative aspect-[20/23] w-full sm:aspect-square", className)}>
      {showLive && ready && (
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="absolute left-1 top-1 z-30 grid size-9 place-items-center rounded-full border border-line-strong bg-ink-800/80 text-fg-muted transition-colors hover:text-fg"
        >
          {paused ? <Play aria-hidden className="size-4" /> : <Pause aria-hidden className="size-4" />}
          <span className="sr-only">{paused ? "Relancer l'animation du globe" : "Mettre en pause l'animation du globe"}</span>
        </button>
      )}
      <div role="img" aria-label={label} className="absolute inset-0">
        {/* Globe carré en haut du visuel ; sur mobile, la place en dessous accueille la carte d'offre */}
        <div aria-hidden className="absolute inset-x-0 top-0 aspect-square">
          {/* La scène dessine le globe sur 84 % du côté : même cadrage que l'image */}
          <GlobeImage hidden={showLive && ready} />
          {showLive && (
            <div className={cn("absolute inset-0 transition-opacity duration-700 ease-out", ready ? "opacity-100" : "opacity-0")}>
              <GlobeBoundary onError={() => setFailed(true)}>
                <GlobeScene reducedMotion={paused} skipIntro onReady={() => setReady(true)} onFail={() => setFailed(true)} />
              </GlobeBoundary>
            </div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
