// Copie d'un texte court (référence de paiement) sans dépendance supplémentaire :
// module natif « Clipboard » du cœur React Native s'il est présent, sinon feuille de partage
// (qui propose « Copier ») ; sur le web, API Clipboard du navigateur puis execCommand. Lecture : readText().
import { Platform, Share, TurboModuleRegistry, type TurboModule } from "react-native";

interface ClipboardModule extends TurboModule {
  setString(content: string): void;
  getString?(): Promise<string>;
}

function nativeClipboard(): ClipboardModule | null {
  try {
    return TurboModuleRegistry.get<ClipboardModule>("Clipboard");
  } catch {
    return null;
  }
}

function webCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const node = document.createElement("textarea");
  node.value = text;
  node.setAttribute("readonly", "");
  node.style.position = "fixed";
  node.style.opacity = "0";
  document.body.appendChild(node);
  node.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(node);
  return ok;
}

/**
 * Copie `text` dans le presse-papiers.
 * @returns « copied » si copié, « shared » si la feuille de partage a été ouverte (l'utilisateur copie lui-même), « failed » sinon.
 */
export async function copyText(text: string): Promise<"copied" | "shared" | "failed"> {
  if (Platform.OS === "web") {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return "copied";
      }
    } catch {
      /* permission refusée : repli execCommand */
    }
    return webCopy(text) ? "copied" : "failed";
  }
  try {
    const native = nativeClipboard();
    if (native) {
      native.setString(text);
      return "copied";
    }
  } catch {
    /* module absent de cette version de React Native */
  }
  try {
    await Share.share({ message: text });
    return "shared";
  } catch {
    return "failed";
  }
}

/** Lecture du presse-papiers possible sur cet appareil (bouton « Coller » affiché seulement dans ce cas). */
export function canReadText(): boolean {
  if (Platform.OS === "web") return typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";
  return typeof nativeClipboard()?.getString === "function";
}

/** Texte du presse-papiers (iOS peut demander l'autorisation de coller) ; null si indisponible ou refusé. */
export async function readText(): Promise<string | null> {
  try {
    if (Platform.OS === "web") return (await navigator.clipboard.readText()) || null;
    return (await nativeClipboard()?.getString?.()) || null;
  } catch {
    return null;
  }
}
