import { Ionicons } from "@expo/vector-icons";
import { VEHICLE_CATEGORY_META } from "@rydar/shared";
import Constants from "expo-constants";
import { router } from "expo-router";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BigButton, Card, Label, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { colors } from "@/theme";

export default function Profile() {
  const { home, signOut } = useDriver();
  const v = home?.vehicle;
  return (
    <Screen>
      <SafeAreaView style={{ flex: 1, padding: 18, gap: 14 }}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} style={styles.back}><Ionicons name="chevron-back" size={22} color={colors.fg} /></Pressable>
          <Text style={styles.title}>Mon compte</Text>
          <View style={{ width: 44 }} />
        </View>
        <Card style={{ alignItems: "center", gap: 6, paddingVertical: 26 }}>
          <View style={styles.avatar}><Text style={styles.avatarText}>{home?.driver.first_name?.charAt(0)}{home?.driver.last_name?.charAt(0)}</Text></View>
          <Text style={styles.name}>{home?.driver.first_name} {home?.driver.last_name}</Text>
          <Text style={styles.sub}>Chauffeur #{home?.driver.number} · {home?.organization.name}</Text>
        </Card>
        <Card style={{ gap: 10 }}>
          <Label>Véhicule</Label>
          <Text style={styles.vehicle}>{v ? `${v.brand ?? ""} ${v.model}` : "Aucun véhicule"}</Text>
          {v && <Text style={styles.sub}>{v.plate} · {VEHICLE_CATEGORY_META[v.category].label} · {v.seats} places</Text>}
        </Card>
        {home?.organization.phone && (
          <Pressable onPress={() => void Linking.openURL(`tel:${home.organization.phone}`)}>
            <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Ionicons name="call-outline" size={20} color={colors.brand} />
              <Text style={styles.vehicle}>Appeler la centrale</Text>
            </Card>
          </Pressable>
        )}
        <View style={{ marginTop: "auto", gap: 10 }}>
          <BigButton title="Se déconnecter" variant="danger" height={56} onPress={async () => { await signOut(); router.replace("/login"); }} />
          <Text style={styles.version}>Rydar Drive {Constants.expoConfig?.version}</Text>
        </View>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  back: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface2 },
  title: { color: colors.fg, fontSize: 18, fontWeight: "800" },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.surface3, borderWidth: 2, borderColor: "rgba(200,240,60,0.5)", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  avatarText: { color: colors.fg, fontSize: 24, fontWeight: "800" },
  name: { color: colors.fg, fontSize: 22, fontWeight: "800" },
  sub: { color: colors.subtle, fontSize: 14 },
  vehicle: { color: colors.fg, fontSize: 16, fontWeight: "700" },
  version: { color: colors.subtle, textAlign: "center", fontSize: 12 },
});
