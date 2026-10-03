// Mon compte : identité, accès aux gains / commissions / documents / messages, véhicule, centrale, réseau partagé
// (réglage, conditions, coordonnées bancaires), déconnexion.
import { Ionicons } from "@expo/vector-icons";
import { VEHICLE_CATEGORY_META, formatPrice, type NetworkReadinessAction } from "@rydar/shared";
import Constants from "expo-constants";
import { router, useFocusEffect } from "expo-router";
import { Children, Fragment, useCallback, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { frTypo, TrustBadge } from "@/components/centrale";
import { buildDocEntries, needsAction } from "@/components/documents";
import { BigButton, hapticResult, Screen, ScreenHeader } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api, legalUrl } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import {
  driverNetworkStatus, enableNeedsTerms, hasPartnerMoney, maskIban, networkVisible, PARTNER_SETTLEMENTS_TITLE, settleHref,
  type NetworkStatusTone,
} from "@/lib/network";
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

const STATUS_COLOR: Record<NetworkStatusTone, string> = { green: colors.green, amber: colors.amber, red: colors.red, muted: colors.muted };

export default function Profile() {
  const { home, signOut, chat, network, refreshNetwork, applyNetwork } = useDriver();
  const v = home?.vehicle;
  const tz = home?.organization.timezone;
  // Réseau partagé : visible seulement si Rydar l'a ouvert ET que l'organisation du chauffeur le reçoit
  const showNetwork = networkVisible(network);
  const status = network && showNetwork ? driverNetworkStatus(network, tz) : null;
  const payout = network?.payout ?? null;
  // Sommes partenaires ouvertes : l'entrée reste visible même réseau coupé ensuite
  const partnerMoney = hasPartnerMoney(home?.network);
  const [toggling, setToggling] = useState(false);
  useFocusEffect(useCallback(() => void refreshNetwork(), [refreshNetwork]));

  /** Interrupteur « Courses du réseau partagé » : conditions en vigueur acceptées d'abord (écran), arrêt confirmé. */
  async function setNetworkEnabled(next: boolean) {
    if (!network || toggling) return;
    if (next && enableNeedsTerms(network)) {
      router.push("/network-terms");
      return;
    }
    const run = async () => {
      setToggling(true);
      try {
        applyNetwork(await api.setNetwork(next, next ? network.terms.version : null));
        hapticResult(true);
      } catch (e) {
        hapticResult(false);
        Alert.alert(next ? "Activation impossible" : "Arrêt impossible", frTypo((e as Error).message));
      } finally {
        setToggling(false);
      }
    };
    if (next) return void run();
    Alert.alert(
      frTypo("Arrêter les courses du réseau partagé ?"),
      "Vous ne recevrez plus les courses des organisations partenaires. Les courses déjà acceptées restent à faire.",
      [{ text: "Annuler", style: "cancel" }, { text: "Arrêter", style: "destructive", onPress: () => void run() }],
    );
  }

  /** Bouton du premier manque (lisibilité du réseau). */
  function runNetworkAction(kind: NetworkReadinessAction) {
    if (kind === "enable_network") return void setNetworkEnabled(true);
    if (kind === "open_network_terms") return router.push("/network-terms");
    if (kind === "open_documents") return router.push("/documents");
    if (kind === "pay_own") return router.push("/commissions");
    if (kind === "pay_network") return router.push(settleHref("network"));
    // Application à jour (celle-ci) : signe de vie renvoyé, puis état relu
    if (kind === "update_app") void api.networkPing().catch(() => null).then(() => refreshNetwork());
  }
  const [docsTodo, setDocsTodo] = useState<number | null>(null);
  // Déconnexion hors réseau : jusqu'à ~30 s (renouvellement du jeton tenté) — bouton en attente
  const [leaving, setLeaving] = useState(false);

  // Pastille « à mettre à jour » : manquants, refusés, expirés ou bientôt échus, déposables dans l'application
  // (visite médicale : plus déposable, jamais comptée)
  const loadDocs = useCallback(() => {
    api
      .documents()
      .then((d) => setDocsTodo(buildDocEntries(d).filter(needsAction).length))
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
            {/* Flotte : règlements des courses partenaires (le chauffeur règle lui-même l'organisation qui les confie) */}
            {!centrale && (partnerMoney || showNetwork) && (
              <Row
                icon="swap-horizontal-outline"
                title={PARTNER_SETTLEMENTS_TITLE}
                detail={partnerDetail(home?.network)}
                detailColor={home?.network && home.network.owed_cents > 0 ? colors.amber : home?.network && home.network.payout_due_cents > 0 ? colors.green : undefined}
                onPress={() => router.push(settleHref("network"))}
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

          {status && network && (
            <>
              <Text style={styles.section} accessibilityRole="header">Réseau partagé</Text>
              <Group>
                <View style={styles.networkRow}>
                  <Pressable
                    onPress={() => void setNetworkEnabled(!network.enabled)}
                    disabled={toggling}
                    style={({ pressed }) => [styles.switchRow, pressed && { backgroundColor: colors.surface2 }]}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: network.enabled, disabled: toggling }}
                    accessibilityLabel={`Courses du réseau partagé, ${status.title}`}
                  >
                    <Ionicons name="swap-horizontal-outline" size={ICON} color={colors.muted} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.rowTitle}>Courses du réseau partagé</Text>
                      <Text style={[styles.rowDetail, { color: STATUS_COLOR[status.tone] }]}>{status.title}</Text>
                    </View>
                    <Switch
                      value={network.enabled}
                      disabled={toggling}
                      onValueChange={(next) => void setNetworkEnabled(next)}
                      trackColor={{ false: colors.subtle, true: colors.brand }}
                      thumbColor={colors.fg}
                      ios_backgroundColor={colors.subtle}
                      accessibilityElementsHidden
                      importantForAccessibility="no"
                    />
                  </Pressable>
                  {status.hint || status.action || status.warning ? (
                    <View style={styles.networkBody}>
                      {status.hint ? <Text style={styles.networkHint}>{status.hint}</Text> : null}
                      {status.action ? (
                        <BigButton
                          title={status.action.kind === "update_app" ? "Actualiser" : status.action.label}
                          variant="secondary"
                          height={control.sm}
                          onPress={() => runNetworkAction(status.action!.kind)}
                          style={styles.networkAction}
                        />
                      ) : null}
                      {status.warning ? (
                        <>
                          <Text style={[styles.networkHint, { color: colors.amber }]}>{status.warning.text}</Text>
                          <BigButton
                            title={status.warning.action.label}
                            variant="secondary"
                            height={control.sm}
                            onPress={() => runNetworkAction(status.warning!.action.kind)}
                            style={styles.networkAction}
                          />
                        </>
                      ) : null}
                    </View>
                  ) : null}
                </View>
                <Row icon="document-text-outline" title="Conditions du réseau partagé" onPress={() => router.push("/network-terms")} />
                <Row
                  icon="card-outline"
                  title="Mes coordonnées bancaires"
                  detail={payout?.configured ? `IBAN ${maskIban(payout.iban_last4)}` : "Pour recevoir vos versements"}
                  onPress={() => router.push("/payout")}
                />
              </Group>
            </>
          )}
          {/* Réseau coupé ensuite : coordonnées bancaires encore utiles tant qu'un versement est attendu */}
          {!status && (payout?.configured || (home?.network?.payout_due_cents ?? 0) > 0) && (
            <>
              <Text style={styles.section} accessibilityRole="header">{PARTNER_SETTLEMENTS_TITLE}</Text>
              <Group>
                <Row
                  icon="card-outline"
                  title="Mes coordonnées bancaires"
                  detail={payout?.configured ? `IBAN ${maskIban(payout.iban_last4)}` : "Pour recevoir vos versements"}
                  onPress={() => router.push("/payout")}
                />
              </Group>
            </>
          )}

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

/** Détail de l'entrée « Courses partenaires » : à régler, à recevoir, ou à jour. */
function partnerDetail(n: { owed_cents: number; payout_due_cents: number } | null | undefined) {
  if (!n) return undefined;
  if (n.owed_cents > 0) return `${formatPrice(n.owed_cents)} à régler`;
  if (n.payout_due_cents > 0) return `${formatPrice(n.payout_due_cents)} à recevoir`;
  return "À jour";
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
  networkRow: { paddingBottom: space.xs },
  switchRow: { flexDirection: "row", alignItems: "center", gap: ROW_GAP, minHeight: control.md + space.xs, paddingHorizontal: ROW_PAD, paddingVertical: space.md },
  networkBody: { gap: space.sm, paddingLeft: ROW_PAD + ICON + ROW_GAP, paddingRight: ROW_PAD, paddingBottom: space.md },
  networkHint: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  networkAction: { alignSelf: "flex-start", minWidth: 160 },
  footer: { marginTop: "auto", paddingTop: space.xl, gap: space.md },
  version: { color: colors.muted, textAlign: "center", fontSize: type.caption },
});
