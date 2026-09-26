import { Redirect, Stack } from "expo-router";
import { useDriver } from "@/hooks/driver-context";
import { colors } from "@/theme";

export default function AppLayout() {
  const { ready, session, canDrive } = useDriver();
  if (!ready) return null;
  if (!session) return <Redirect href="/login" />;
  // Compte devenu inactif (banni, suspendu…) ou candidature pas encore validée : écran d'état du compte
  if (!canDrive) return <Redirect href="/account" />;
  return (
    // iOS 26 : sans réglage, le geste « retour » couvre tout l'écran → un glissement vers la droite (glissière
    // « Aller au départ », listes horizontales) ramenait à l'écran précédent. Retour depuis le bord seulement.
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, fullScreenGestureEnabled: false }}>
      <Stack.Screen name="home" />
      <Stack.Screen name="offer/[id]" options={{ presentation: "fullScreenModal", animation: "fade_from_bottom", gestureEnabled: false }} />
      {/* Course en cours : aucun geste de retour (bouton ‹ seulement) — la glissière de statut se fait vers la droite */}
      <Stack.Screen name="ride/[id]" options={{ animation: "slide_from_right", gestureEnabled: false }} />
      <Stack.Screen name="planning" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="profile" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="messages" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="earnings" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="documents" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="commissions" options={{ animation: "slide_from_right" }} />
    </Stack>
  );
}
