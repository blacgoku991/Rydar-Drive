"use client";

import dynamic from "next/dynamic";
import { Component, useState, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { RadarScene } from "./radar-scene";

// three.js n'est téléchargé que si le navigateur sait afficher la scène (WebGL 2), après l'affichage de la page.
const GlobeScene = dynamic(() => import("./globe-scene"), { ssr: false });

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const reducedMotionSnapshot = () => window.matchMedia(REDUCED_MOTION).matches;

let webgl2: boolean | undefined;
/** WebGL 2 disponible (three.js ≥ r163 ne gère plus WebGL 1). Contexte de test libéré aussitôt. */
function webgl2Snapshot() {
  if (webgl2 === undefined) {
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      webgl2 = !!gl;
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}
const subscribeNever = () => () => {};

/**
 * Frontière d'erreur du globe : module three.js introuvable (réseau instable, page servie par l'ancienne version
 * pendant une mise à jour) ou erreur de la scène. Sans elle, l'erreur remonterait jusqu'à l'écran d'erreur de Next,
 * qui remplacerait toute la page ; ici, le parent affiche simplement le radar CSS.
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

/**
 * Visuel du héro : globe 3D (radar de dispatch sur la France) chargé à la demande, silhouette CSS pendant le
 * chargement, radar CSS si WebGL est indisponible, si le module 3D ne se charge pas, en cas d'erreur de la scène
 * ou si le contexte est perdu. Image figée si l'utilisateur a demandé moins d'animations.
 */
export function HeroVisual({ label, children, className }: { label: string; children?: ReactNode; className?: string }) {
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
  const canRender = useSyncExternalStore<boolean | null>(subscribeNever, webgl2Snapshot, () => null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const mode = canRender === null ? "pending" : canRender && !failed ? "globe" : "fallback";

  return (
    <div role="img" aria-label={label} className={cn("relative aspect-[20/23] w-full sm:aspect-square", className)}>
      {/* Scène carrée en haut du visuel ; sur mobile, la place en dessous accueille la carte d'offre */}
      <div className="absolute inset-x-0 top-0 aspect-square">
        {mode !== "fallback" && (
          <div
            aria-hidden
            className={cn(
              "absolute inset-0 grid place-items-center transition-opacity duration-1000 ease-out motion-reduce:transition-none",
              ready ? "opacity-0" : "opacity-100",
            )}
          >
            {/* Silhouette du globe (mêmes proportions que la scène : 84 % du côté) */}
            <div className="relative size-[84%] rounded-full bg-[radial-gradient(circle_at_34%_30%,var(--color-ink-700),var(--color-ink-850)_58%,var(--color-ink-900))] shadow-[0_0_0_1px_rgb(200_240_60/0.08),0_0_80px_-10px_rgb(200_240_60/0.22)]">
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgb(158_165_177/0.16)_1px,transparent_1.6px)] bg-[length:11px_11px] [mask-image:radial-gradient(circle_at_40%_36%,black,transparent_72%)]" />
            </div>
          </div>
        )}
        {mode === "globe" && (
          <div
            aria-hidden
            className={cn("absolute inset-0 transition-opacity duration-1000 ease-out motion-reduce:transition-none", ready ? "opacity-100" : "opacity-0")}
          >
            <GlobeBoundary onError={() => setFailed(true)}>
              <GlobeScene reducedMotion={reducedMotion} onReady={() => setReady(true)} onFail={() => setFailed(true)} />
            </GlobeBoundary>
          </div>
        )}
        {mode === "fallback" && (
          <div aria-hidden className="absolute inset-0 grid place-items-center">
            <RadarScene className="w-[88%]" />
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
