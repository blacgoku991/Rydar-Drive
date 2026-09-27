// Mon compte : identité, accès aux gains / commissions / documents / messages, véhicule, centrale, déconnexion.
import { Ionicons } from "@expo/vector-icons";
import { VEHICLE_CATEGORY_META, formatPrice } from "@rydar/shared";
import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { Children, Fragment, useCallback, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { TrustBadge } from "@/components/centrale";
import { BigButton, Screen, ScreenHeader } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api, legalUrl } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

const NBSP = "\u00A0";
type IconName = keyof typeof Ionicons.glyphMap;

const ICON = 20;
const ROW_PAD = space.lg;
const ROW_GAP = 14;

/** Ligne de réglage : icône neutre, titre, détail (coloré seulement quand il signale un état), chevron. */
function Row({ icon, title, detail, detailColor, onPress }: { icon: IconName; title: string; detail?: string; detailColor?: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface2 }]}
    >
      <Ionicons name={icon} size={ICON} color={colors.muted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={[styles.rowDetail, detailColor ? { color: detailColor } : null]} numberOfLines={1}>{detail}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.subtle} />
    </Pressable>
  );
}

/** Groupe de lignes séparées par un filet de 1 px aligné sur les titres. */
function Group({ children }: { children: React.ReactNode }) {
  const items = Children.toArray(children);
  return (
    <View style={styles.group}>
      {items.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && <View style={styles.sep} />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

export default function Profile() {
  const { home, signOut, chat } = useDriver();
  const v = home?.vehicle;
  const [docsTodo, setDocsTodo] = useState<number | null>(null);
  // Déconnexion hors réseau : jusqu'à ~30 s (renouvellement du jeton tenté) — bouton en attente
  const [leaving, setLeaving] = useState(false);

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
  // Mode centrale : gains nets (part chauffeur) et commissions à régler / à recevoir
  const centrale = (home?.model ?? home?.organization.dispatch_model) === "centrale";
  const s = centrale ? home?.settlement ?? null : null;
  const commissionsDetail = !s
    ? undefined
    : s.blocked
      ? `Courses bloquées · ${formatPrice(s.owed_cents)} à régler`
      : s.owed_cents > 0
        ? `${formatPrice(s.owed_cents)} à régler`
        : s.declared_cents > 0
          ? `${formatPrice(s.declared_cents)} en attente de confirmation`
          : s.to_receive_cents > 0
            ? `${formatPrice(s.to_receive_cents)} à recevoir`
            : "À jour";
  // Couleur seulement pour un état qui demande attention (ou un montant à recevoir) ; « À jour » reste neutre
  const commissionsColor = !s
    ? undefined
    : s.blocked
      ? colors.red
      : s.owed_cents > 0
        ? colors.amber
        : s.declared_cents > 0
          ? colors.blue
          : s.to_receive_cents > 0
            ? colors.green
            : undefined;

  const d = home?.driver;
  const initials = `${d?.first_name?.charAt(0) ?? ""}${d?.last_name?.charAt(0) ?? ""}`.toUpperCase();
  const fullName = d ? `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim() : "";
  const unread = chat?.unread_total ?? 0;
  const phone = home?.organization.phone;

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <ScreenHeader title="Mon compte" />
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.identity} accessible accessibilityLabel={fullName ? `${fullName}, chauffeur ${d?.number ?? ""}, ${home?.organization.name ?? ""}` : "Chargement du compte"}>
            <View style={styles.avatar}>
              {initials ? <Text style={styles.avatarText}>{initials}</Text> : <Ionicons name="person-outline" size={24} color={colors.muted} />}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name} numberOfLines={1}>{fullName || "—"}</Text>
              {d && (
                <Text style={styles.sub} numberOfLines={1}>
                  Chauffeur n°{NBSP}<Text style={mono}>{d.number}</Text>
                  {home?.organization.name ? ` · ${home.organization.name}` : ""}
                </Text>
              )}
              {centrale && <TrustBadge level={d?.trust_level} style={{ marginTop: space.xs }} />}
            </View>
          </View>

          <Group>
            <Row
              icon="wallet-outline"
              title="Mes gains"
              detail={`${formatPrice(centrale ? home?.today.net_cents ?? 0 : home?.today.revenue_cents ?? 0)} aujourd'hui`}
              onPress={() => router.push("/earnings")}
            />
            {centrale && (
              <Row
                icon={s?.blocked ? "lock-closed-outline" : "cash-outline"}
                title="Commissions"
                detail={commissionsDetail}
                detailColor={commissionsColor}
                onPress={() => router.push("/commissions")}
              />
            )}
            <Row
              icon="folder-open-outline"
              title="Mes documents"
              detail={docsTodo == null ? undefined : docsTodo > 0 ? `${docsTodo} à mettre à jour` : "À jour"}
              detailColor={docsTodo != null && docsTodo > 0 ? colors.amber : undefined}
              onPress={() => router.push("/documents")}
            />
            <Row
              icon="chatbubbles-outline"
              title="Messages"
              detail={unread > 0 ? `${unread} non lu${unread > 1 ? "s" : ""}` : undefined}
              detailColor={colors.fg}
              onPress={() => router.push("/messages")}
            />
          </Group>

          <Text style={styles.section} accessibilityRole="header">Véhicule</Text>
          <View style={styles.group}>
            <View style={styles.row} accessible>
              <Ionicons name="car-outline" size={ICON} color={colors.muted} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[styles.rowTitle, !v && { color: colors.muted }]} numberOfLines={1}>
                  {v ? `${v.brand ?? ""} ${v.model}`.trim() : "Aucun véhicule"}
                </Text>
                {v && (
                  <Text style={styles.rowDetail} numberOfLines={1}>
                    <Text style={mono}>{v.plate}</Text> · {VEHICLE_CATEGORY_META[v.category].label} · {v.seats}{NBSP}{v.seats > 1 ? "places" : "place"}
                  </Text>
                )}
              </View>
            </View>
          </View>

          {phone && (
            <>
              <Text style={styles.section} accessibilityRole="header">Centrale</Text>
              <Group>
                <Row icon="call-outline" title="Appeler la centrale" detail={phone} onPress={() => void Linking.openURL(`tel:${phone}`)} />
              </Group>
            </>
          )}

          <Text style={styles.section} accessibilityRole="header">Conditions et confidentialité</Text>
          <Group>
            {legalUrl("cgu") ? (
              <Row icon="document-text-outline" title="Conditions d'utilisation" onPress={() => void Linking.openURL(legalUrl("cgu")!).catch(() => null)} />
            ) : null}
            {legalUrl("confidentialite") ? (
              <Row icon="shield-checkmark-outline" title="Politique de confidentialité" onPress={() => void Linking.openURL(legalUrl("confidentialite")!)} />
            ) : null}
            <Row icon="trash-outline" title="Supprimer mon compte" onPress={() => router.push("/delete-account")} />
          </Group>

          <View style={styles.footer}>
            <BigButton
              title="Se déconnecter"
              variant="danger"
              icon="log-out-outline"
              height={control.md}
              loading={leaving}
              onPress={async () => {
                setLeaving(true);
                try {
                  await signOut();
                } finally {
                  setLeaving(false);
                }
                router.replace("/login");
              }}
            />
            <Text style={styles.version}>Rydar Drive {Constants.expoConfig?.version}</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg, gap: space.md },
  identity: { flexDirection: "row", alignItems: "center", gap: space.lg, paddingVertical: space.md, marginBottom: space.xs },
  avatar: { width: 56, height: 56, borderRadius: radius.full, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.fg, fontSize: type.title3, fontWeight: weight.semibold },
  name: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold },
  sub: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.regular },
  section: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.semibold, marginTop: space.sm, marginLeft: space.xs },
  group: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: ROW_GAP, minHeight: control.md + space.xs, paddingHorizontal: ROW_PAD, paddingVertical: space.md },
  rowTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.medium },
  rowDetail: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.regular },
  sep: { height: 1, backgroundColor: colors.line, marginLeft: ROW_PAD + ICON + ROW_GAP },
  footer: { marginTop: "auto", paddingTop: space.xl, gap: space.md },
  version: { color: colors.muted, textAlign: "center", fontSize: type.caption },
});
