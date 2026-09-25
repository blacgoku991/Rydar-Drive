import { Redirect, Stack } from "expo-router";
import { useDriver } from "@/hooks/driver-context";
import { colors } from "@/theme";

export default function AppLayout() {
  const { ready, session } = useDriver();
  if (!ready) return null;
  if (!session) return <Redirect href="/login" />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="home" />
      <Stack.Screen name="offer/[id]" options={{ presentation: "fullScreenModal", animation: "fade_from_bottom", gestureEnabled: false }} />
      <Stack.Screen name="ride/[id]" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="planning" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="profile" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="messages" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="earnings" options={{ animation: "slide_from_right" }} />
      <Stack.Screen name="documents" options={{ animation: "slide_from_right" }} />
    </Stack>
  );
}
