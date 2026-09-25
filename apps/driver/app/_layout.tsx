import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DriverProvider, useDriver } from "@/hooks/driver-context";
import { colors } from "@/theme";

void SplashScreen.preventAutoHideAsync().catch(() => null);

function Gate() {
  const { ready } = useDriver();
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => null);
  }, [ready]);
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: "fade" }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="account" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaProvider>
        <DriverProvider>
          <StatusBar style="light" />
          <Gate />
        </DriverProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
