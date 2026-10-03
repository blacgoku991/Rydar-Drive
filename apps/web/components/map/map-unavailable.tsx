import { MapPinOff } from "lucide-react";

/** À la place d'une carte que le navigateur ne peut pas afficher (WebGL 2 absent ou désactivé : MapLibre l'exige). */
export function MapUnavailable() {
  return (
    <div role="status" className="absolute inset-0 z-10 grid place-items-center bg-ink-900 p-6 text-center">
      <div className="max-w-sm">
        <MapPinOff aria-hidden className="mx-auto mb-3 size-6 text-fg-muted" />
        <p className="text-sm font-medium text-fg">Carte indisponible sur ce navigateur</p>
        <p className="mt-1 text-[13px] leading-5 text-fg-muted">
          Elle a besoin de WebGL 2 (accélération graphique). Activez l'accélération matérielle dans les réglages du
          navigateur, ou ouvrez cette page dans un navigateur à jour.
        </p>
      </div>
    </div>
  );
}
