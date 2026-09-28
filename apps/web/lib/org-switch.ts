// Centrale active : un seul cookie (rd_org) pour tous les onglets. Quand un onglet change de centrale, les autres
// l'apprennent ici et cessent d'agir au nom de la centrale qu'ils affichent encore (auth-web#6).
// BroadcastChannel (un canal par onglet : un message n'est pas remis à l'onglet qui l'envoie) ; repli sur l'événement
// « storage » (émis lui aussi dans les autres onglets seulement).

const CHANNEL = "rd_org";
const STORAGE_KEY = "rd_org_switch";

let channel: BroadcastChannel | null | undefined;

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  return channel;
}

/** À appeler après un changement de centrale réussi (cookie posé). */
export function announceOrgSwitch(orgId: string) {
  const ch = getChannel();
  if (ch) {
    try {
      ch.postMessage({ orgId });
      return;
    } catch {
      // canal fermé : repli
    }
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ orgId, at: Date.now() }));
  } catch {
    // stockage indisponible (navigation privée) : rien à faire
  }
}

function readOrgId(data: unknown): string | null {
  const id = (data as { orgId?: unknown } | null)?.orgId;
  return typeof id === "string" && id ? id : null;
}

/** Écoute les changements de centrale faits dans un AUTRE onglet ; renvoie la fonction de désabonnement. */
export function onOrgSwitch(listener: (orgId: string) => void): () => void {
  const ch = getChannel();
  const onMessage = (e: MessageEvent) => {
    const id = readOrgId(e.data);
    if (id) listener(id);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      const id = readOrgId(JSON.parse(e.newValue));
      if (id) listener(id);
    } catch {
      // valeur illisible : ignorée
    }
  };
  ch?.addEventListener("message", onMessage);
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    ch?.removeEventListener("message", onMessage);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
