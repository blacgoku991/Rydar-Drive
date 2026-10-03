// Écran qui reprend la main (profil, accueil) : affiche la confirmation laissée par l'écran fermé juste avant
// (lib/return-flash.ts), avec son propre bandeau éphémère (useFlash).
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { returnFlash } from "@/lib/return-flash";

export function useReturnFlash(show: (text: string) => void) {
  useFocusEffect(
    useCallback(() => {
      const text = returnFlash.take();
      if (text) show(text);
    }, [show]),
  );
}
