import { Ionicons } from "@expo/vector-icons";
import { VEHICLE_CATEGORY_META, formatPrice } from "@rydar/shared";
import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BigButton, Card, Label, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { colors } from "@/theme";

function Row({ icon, title, detail, detailColor, onPress }: { icon: keyof typeof Ionicons.glyphMap; title: string; detail?: string; detailColor?: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface2 }]}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={19} color={colors.brand} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={[styles.rowDetail, detailColor ? { color: detailColor } : null]} numberOfLines={1}>{detail}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
    </Pressable>
  );
}

export default function Profile() {
  const { home, signOut, chat } = useDriver();
  const v = home?.vehicle;
  const [docsTodo, setDocsTodo] = useState<number | null>(null);

  // Pastille « à mettre à jour » : manquants, refusés, expirés ou bientôt échus
  const loadDocs = useCallback(() => {
    api
      .documents()
      .then((d) => {
        const shown = new Set(d.documents.map((x) => x.type));
        setDocsTodo(d.summary.expired + d.summary.expiring + d.summary.rejected + d.missing_types.filter((t) => !shown.has(t)).length);
      })
      .catch(() => setDocsTodo(null));
  }, []);
  useFocusEffect(useCallback(() => loadDocs(), [loadDocs]));
  useAppEvent("documents", loadDocs);
  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 18, gap: 14 }}>
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
          <Card style={{ padding: 6 }}>
            <Row
              icon="wallet-outline"
              title="Mes gains"
              detail={`${formatPrice(home?.today.revenue_cents ?? 0)} aujourd'hui`}
              onPress={() => router.push("/earnings")}
            />
            <View style={styles.sep} />
            <Row
              icon="folder-open-outline"
              title="Mes documents"
              detail={docsTodo == null ? undefined : docsTodo > 0 ? `${docsTodo} à mettre à jour` : "À jour"}
              detailColor={docsTodo && docsTodo > 0 ? colors.amber : colors.green}
              onPress={() => router.push("/documents")}
            />
            <View style={styles.sep} />
            <Row
              icon="chatbubbles-outline"
              title="Messages"
              detail={chat && chat.unread_total > 0 ? `${chat.unread_total} non lu${chat.unread_total > 1 ? "s" : ""}` : undefined}
              detailColor={colors.brand}
              onPress={() => router.push("/messages")}
            />
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
        </ScrollView>
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
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 14, borderRadius: 14 },
  rowIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(200,240,60,0.1)", alignItems: "center", justifyContent: "center" },
  rowTitle: { color: colors.fg, fontSize: 16, fontWeight: "700" },
  rowDetail: { color: colors.muted, fontSize: 13.5, fontWeight: "700", marginTop: 2 },
  sep: { height: 1, backgroundColor: colors.line, marginHorizontal: 12 },
});
