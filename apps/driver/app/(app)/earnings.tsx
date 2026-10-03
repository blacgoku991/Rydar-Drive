// Gains du chauffeur : jour / semaine / mois, histogramme 7 jours, dernières courses (driver_earnings).
// Mode centrale : « Votre part » (part chauffeur réelle), commission et statut du règlement par course.
// Réseau partagé : course partenaire marquée « Partenaire · {organisation} », net par course (termes figés), UN montant
// avec l'organisation qui l'a confiée (jamais commission ni frais).
import { Ionicons } from "@expo/vector-icons";
import {
  PAYMENT_METHOD_LABELS, SETTLEMENT_STATUS_META, formatDistance, formatDuration, formatPrice, formatRideDate,
  type DriverEarnings, type EarningsPeriod, type EarningsRide, type PaymentMethod,
} from "@rydar/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { driverSettlementLabel } from "@/components/centrale";
import { PartnerBadge } from "@/components/network";
import { BigButton, Card, Label, Pill, Screen, ScreenHeader, Segmented } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { earningsPartner, earningsPartnerText, PARTNER_SETTLEMENTS_TITLE, partnerAccess, settleHref } from "@/lib/network";
import { alpha, colors, control, mono, radius, space, toneColor, type, weight } from "@/theme";

type Period = "today" | "week" | "month";

const NBSP = "\u00A0";

const PAY_ICON: Record<PaymentMethod, keyof typeof Ionicons.glyphMap> = {
  card: "card-outline",
  cash: "cash-outline",
  online: "globe-outline",
  invoice: "document-text-outline",
  account: "business-outline",
};

/** Date « AAAA-MM-JJ » (fuseau org) → libellés sans décalage de fuseau. */
const fromDay = (d: string) => new Date(`${d}T12:00:00Z`);
const weekday = (d: string) => new Intl.DateTimeFormat("fr-FR", { weekday: "short", timeZone: "UTC" }).format(fromDay(d)).replace(".", "");
const dayLong = (d: string) => new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(fromDay(d));
const plural = (n: number, one: string, many: string) => `${n}${NBSP}${n > 1 ? many : one}`;

function periodTitle(p: Period, e: DriverEarnings) {
  if (p === "today") return "Aujourd'hui";
  if (p === "week") return "Cette semaine";
  const month = new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: e.timezone }).format(new Date(e.month.from));
  return `${month.charAt(0).toUpperCase()}${month.slice(1)}`;
}

export default function Earnings() {
  const { home, network } = useDriver();
  const [data, setData] = useState<DriverEarnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("today");
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.earnings(7));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));
  // Statut des règlements (mode centrale) : commission déclarée, confirmée, contestée…
  useAppEvent("settlements", () => void load());

  const p: EarningsPeriod | null = data ? data[period] : null;
  const currency = data?.currency ?? "EUR";
  const commission = data?.commission_percent ?? null;
  // Mode centrale : la part chauffeur (driver_payout_cents) est le montant qui compte
  const centrale = data?.model === "centrale";
  const dayValue = useCallback((d: { revenue_cents: number; net_cents: number | null }) => (centrale ? d.net_cents ?? 0 : d.revenue_cents), [centrale]);
  const series = data?.series ?? [];
  const max = useMemo(() => Math.max(1, ...series.map(dayValue)), [series, dayValue]);
  const today = series.length - 1;
  const sel = selectedDay ?? today;
  const selDay = series[sel];
  const weekTotal = series.reduce((s, d) => s + dayValue(d), 0);
  const settlement = centrale ? home?.settlement ?? null : null;

  // Accès aux commissions : l'icône porte l'état (bloqué, à régler, signalé, à recevoir)
  const commissionState = settlement?.blocked
    ? { icon: "lock-closed-outline" as const, color: colors.red, text: `Courses bloquées${NBSP}: réglez vos commissions` }
    : settlement && settlement.owed_cents > 0
      ? { icon: "wallet-outline" as const, color: colors.amber, text: `${formatPrice(settlement.owed_cents, currency)} à régler à la centrale` }
      : settlement && settlement.declared_cents > 0
        ? { icon: "time-outline" as const, color: colors.blue, text: `${formatPrice(settlement.declared_cents, currency)} signalé payé, à confirmer` }
        : settlement && settlement.to_receive_cents > 0
          ? { icon: "arrow-down-circle-outline" as const, color: colors.green, text: `${formatPrice(settlement.to_receive_cents, currency)} à recevoir` }
          : { icon: "wallet-outline" as const, color: colors.muted, text: "Tout est réglé" };
  // Flotte : accès aux règlements des courses partenaires (centrale : onglet de l'écran Commissions) ; réseau coupé ou
  // non reçu, sans somme partenaire : aucune entrée (lib/network.ts : partnerAccess)
  const partnerNet = home?.network ?? null;
  const showPartners = partnerAccess({ model: data?.model ?? home?.model ?? home?.organization.dispatch_model, homeNetwork: partnerNet, network }).entry;
  const partnerState = partnerNet && partnerNet.owed_cents > 0
    ? { icon: "wallet-outline" as const, color: colors.amber, text: `${formatPrice(partnerNet.owed_cents, currency)} à régler` }
    : partnerNet && partnerNet.payout_due_cents > 0
      ? { icon: "arrow-down-circle-outline" as const, color: colors.green, text: `${formatPrice(partnerNet.payout_due_cents, currency)} à recevoir` }
      : { icon: "swap-horizontal-outline" as const, color: colors.muted, text: "Tout est réglé" };

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ScreenHeader title="Mes gains" />
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              tintColor={colors.muted}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
        >
          <Segmented
            value={period}
            onChange={setPeriod}
            options={[
              { value: "today", label: "Jour" },
              { value: "week", label: "Semaine" },
              { value: "month", label: "Mois" },
            ]}
          />

          {!data || !p ? (
            <View style={styles.loading}>
              {error ? (
                <>
                  <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text>
                  <BigButton
                    title="Réessayer"
                    variant="secondary"
                    height={control.sm}
                    loading={retrying}
                    style={{ alignSelf: "center", minWidth: 160 }}
                    onPress={async () => {
                      setRetrying(true);
                      await load();
                      setRetrying(false);
                    }}
                  />
                </>
              ) : (
                <ActivityIndicator color={colors.muted} accessibilityLabel="Chargement des gains" />
              )}
            </View>
          ) : (
            <>
              {/* Montant de la période */}
              <View style={styles.hero}>
                <Label>{periodTitle(period, data)}{centrale ? " · votre part" : ""}</Label>
                {centrale ? (
                  <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={`Votre part ${formatPrice(p.net_cents ?? 0, currency)}`}>
                    {formatPrice(p.net_cents ?? 0, currency)}
                  </Text>
                ) : (
                  <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={`Chiffre d'affaires ${formatPrice(p.revenue_cents, currency)}`}>
                    {formatPrice(p.revenue_cents, currency)}
                  </Text>
                )}
                <View style={styles.stats}>
                  <Stat value={`${p.rides}`} label={p.rides > 1 ? "courses" : "course"} />
                  <View style={styles.statSep} />
                  <Stat value={formatDistance(p.distance_m)} label="parcourus" />
                  <View style={styles.statSep} />
                  <Stat value={formatDuration(p.duration_s)} label="en course" />
                </View>
                {centrale ? (
                  <View style={styles.net}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.netLabel}>Courses {formatPrice(p.revenue_cents, currency)}</Text>
                      <Text style={styles.netHint}>Moins commission et frais de la centrale</Text>
                    </View>
                    <Text style={styles.netValue} accessibilityLabel={`Moins ${formatPrice(p.commission_cents ?? 0, currency)}`}>
                      −{formatPrice(p.commission_cents ?? 0, currency)}
                    </Text>
                  </View>
                ) : commission != null && p.net_cents != null && (
                  <View style={styles.net}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.netLabel}>Net estimé</Text>
                      <Text style={styles.netHint}>Après commission de {String(commission).replace(".", ",")}{NBSP}%</Text>
                    </View>
                    <Text style={styles.netValue}>{formatPrice(p.net_cents, currency)}</Text>
                  </View>
                )}
                {(p.cash_cents > 0 || p.unpriced_rides > 0) && (
                  <View style={styles.notes}>
                    {p.cash_cents > 0 && (
                      <View style={styles.note}>
                        <Ionicons name="cash-outline" size={18} color={colors.muted} />
                        <Text style={styles.noteText}>Dont {formatPrice(p.cash_cents, currency)} en espèces</Text>
                      </View>
                    )}
                    {p.unpriced_rides > 0 && (
                      <View style={styles.note}>
                        <Ionicons name="help-circle-outline" size={18} color={colors.muted} />
                        <Text style={styles.noteText}>{plural(p.unpriced_rides, "course", "courses")} sans prix</Text>
                      </View>
                    )}
                  </View>
                )}
              </View>

              {/* Mode centrale : accès aux commissions (à régler, signalées, à recevoir) */}
              {centrale && (
                <Pressable
                  onPress={() => router.push("/commissions")}
                  style={({ pressed }) => [styles.linkRow, pressed && { backgroundColor: colors.surface2 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Commissions. ${commissionState.text}`}
                >
                  <Ionicons name={commissionState.icon} size={20} color={commissionState.color} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.linkTitle}>Commissions</Text>
                    <Text style={[styles.linkSub, settlement?.blocked && { color: colors.red }]} numberOfLines={2}>
                      {commissionState.text}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.muted} />
                </Pressable>
              )}

              {/* Flotte : règlements des courses partenaires (le chauffeur règle lui-même l'organisation qui les confie) */}
              {showPartners && (
                <Pressable
                  onPress={() => router.push(settleHref("network"))}
                  style={({ pressed }) => [styles.linkRow, pressed && { backgroundColor: colors.surface2 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`${PARTNER_SETTLEMENTS_TITLE}. ${partnerState.text}`}
                >
                  <Ionicons name={partnerState.icon} size={20} color={partnerState.color} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.linkTitle}>{PARTNER_SETTLEMENTS_TITLE}</Text>
                    <Text style={styles.linkSub} numberOfLines={2}>{partnerState.text}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.muted} />
                </Pressable>
              )}

              {/* Histogramme 7 jours */}
              <Card style={{ gap: space.lg }}>
                <View style={styles.chartHead}>
                  <View style={{ flex: 1 }}>
                    <Label>{centrale ? "7 derniers jours · votre part" : "7 derniers jours"}</Label>
                    <Text style={styles.chartTotal}>{formatPrice(weekTotal, currency)}</Text>
                  </View>
                  {selDay && (
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.selDay}>{sel === today ? "Aujourd'hui" : dayLong(selDay.date)}</Text>
                      <Text style={styles.selValue}>
                        {formatPrice(dayValue(selDay), currency)} · {plural(selDay.rides, "course", "courses")}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.chart} accessibilityLabel={`Gains des 7 derniers jours${NBSP}: ${formatPrice(weekTotal, currency)}`}>
                  {series.map((d, i) => {
                    const v = dayValue(d);
                    const h = v > 0 ? Math.max(6, Math.round((v / max) * 120)) : 4;
                    const isToday = i === today;
                    const isSel = i === sel;
                    return (
                      <Pressable
                        key={d.date}
                        style={styles.col}
                        onPress={() => setSelectedDay(i)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: isSel }}
                        accessibilityLabel={`${isToday ? "Aujourd'hui" : dayLong(d.date)}${NBSP}: ${formatPrice(v, currency)}, ${plural(d.rides, "course", "courses")}`}
                      >
                        <View style={styles.barTrack}>
                          <View
                            style={[
                              styles.bar,
                              { height: h, backgroundColor: v === 0 ? colors.surface3 : isSel ? colors.fg : alpha(colors.fg, 0.24) },
                            ]}
                          />
                        </View>
                        <Text style={[styles.dayLabel, isSel && styles.dayLabelSel]}>{isToday ? "auj." : weekday(d.date)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </Card>

              {data.upcoming.rides > 0 && (
                <Card style={styles.upcoming}>
                  <Ionicons name="calendar-outline" size={20} color={colors.muted} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.linkTitle}>À venir</Text>
                    <Text style={styles.linkSub}>
                      {plural(data.upcoming.rides, "course acceptée", "courses acceptées")}
                    </Text>
                  </View>
                  <Text style={styles.upValue}>{formatPrice(centrale ? data.upcoming.net_cents ?? 0 : data.upcoming.revenue_cents, currency)}</Text>
                </Card>
              )}

              <Label style={{ marginTop: space.sm }}>Dernières courses</Label>
              {data.recent.length === 0 ? (
                <Text style={styles.empty}>Aucune course terminée pour le moment.</Text>
              ) : (
                <Card style={{ paddingVertical: space.xs, paddingHorizontal: space.lg }}>
                  {data.recent.map((r, i) => {
                    const when = formatRideDate(r.completed_at, data.timezone);
                    const pay = PAYMENT_METHOD_LABELS[r.payment_method] ?? "";
                    // Course partenaire : sa part (termes figés) comme en centrale, quel que soit le modèle
                    const partner = earningsPartner(r);
                    const share = centrale || partner != null;
                    const amount = share
                      ? `votre part ${formatPrice(r.net_cents, r.currency)} sur ${formatPrice(r.price_cents, r.currency)}`
                      : `${formatPrice(r.price_cents, r.currency)}${r.net_cents != null ? `, net ${formatPrice(r.net_cents, r.currency)}` : ""}`;
                    return (
                      <View
                        key={r.id}
                        style={[styles.ride, i > 0 && styles.rideBorder]}
                        accessible
                        accessibilityLabel={`Course ${r.number}${partner ? `, partenaire, ${partner.giver}` : ""}, ${r.pickup} vers ${r.dropoff}, ${when}, ${pay}, ${amount}`}
                      >
                        <Ionicons name={PAY_ICON[r.payment_method] ?? "card-outline"} size={20} color={colors.muted} style={styles.rideIcon} />
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text style={styles.rideRoute} numberOfLines={1}>{r.pickup} → {r.dropoff}</Text>
                          <Text style={styles.rideMeta} numberOfLines={1}>
                            Course {r.number} · {when}{pay ? ` · ${pay}` : ""}
                          </Text>
                          {partner ? <PartnerSettlement r={r} /> : centrale && <RideSettlement r={r} />}
                        </View>
                        {share ? (
                          <View style={{ alignItems: "flex-end" }}>
                            <Text style={styles.ridePrice}>{formatPrice(r.net_cents, r.currency)}</Text>
                            <Text style={styles.rideNet}>sur {formatPrice(r.price_cents, r.currency)}</Text>
                          </View>
                        ) : (
                          <View style={{ alignItems: "flex-end" }}>
                            <Text style={styles.ridePrice}>{formatPrice(r.price_cents, r.currency)}</Text>
                            {r.net_cents != null && <Text style={styles.rideNet}>net {formatPrice(r.net_cents, r.currency)}</Text>}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </Card>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

/**
 * Course partenaire : organisation qui l'a confiée, statut du règlement et UN montant accordé à ce statut (« 12,50 € à
 * reverser à {A} » / « 12,50 € reversés à {A} », « {A} vous versera 37,50 € » / « Part versée par {A} »), jamais
 * commission ni frais.
 */
function PartnerSettlement({ r }: { r: EarningsRide }) {
  const p = earningsPartner(r);
  if (!p) return null;
  const status = r.settlement_status ?? null;
  const direction = p.collects ? "driver_owes" : "centrale_owes";
  return (
    <View style={styles.settle}>
      <PartnerBadge giver={p.giver} />
      {status ? <Pill label={driverSettlementLabel(status, direction)} color={toneColor(SETTLEMENT_STATUS_META[status].tone)} /> : null}
      <Text style={styles.settleText}>{earningsPartnerText(r)}</Text>
    </View>
  );
}

/** Mode centrale : commission de la course et statut du règlement (« À régler », « Encaissé », « À recevoir »…). */
function RideSettlement({ r }: { r: EarningsRide }) {
  const deduction = (r.commission_cents ?? 0) + (r.platform_fee_cents ?? 0);
  const status = r.settlement_status ?? null;
  const direction = r.settlement_direction ?? (r.payment_method === "cash" || r.payment_method === "card" ? "driver_owes" : "centrale_owes");
  return (
    <View style={styles.settle}>
      {status ? <Pill label={driverSettlementLabel(status, direction)} color={toneColor(SETTLEMENT_STATUS_META[status].tone)} /> : null}
      <Text style={styles.settleText}>
        {direction === "driver_owes" ? `Commission ${formatPrice(deduction, r.currency)}` : "Part versée par la centrale"}
      </Text>
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${value} ${label}`}>
      <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 48 },
  loading: { paddingVertical: 80, alignItems: "center", gap: space.lg },
  error: { color: colors.red, fontSize: type.body, textAlign: "center", lineHeight: 21 },
  hero: {
    borderRadius: radius.lg, padding: 20, gap: space.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
  },
  amount: { color: colors.fg, fontSize: type.display, fontWeight: weight.bold, letterSpacing: -0.5, marginTop: -space.sm, ...mono },
  stats: { flexDirection: "row", alignItems: "center", paddingVertical: space.xs },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statSep: { width: 1, height: 32, backgroundColor: colors.line },
  statValue: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold, ...mono },
  statLabel: { color: colors.muted, fontSize: type.footnote },
  net: {
    flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.md, backgroundColor: colors.surface2,
  },
  netLabel: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, ...mono },
  netHint: { color: colors.muted, fontSize: type.footnote, marginTop: 2 },
  netValue: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold, ...mono },
  notes: { gap: space.sm },
  note: { flexDirection: "row", alignItems: "center", gap: space.sm },
  noteText: { color: colors.muted, fontSize: type.subhead, ...mono },
  linkRow: {
    flexDirection: "row", alignItems: "center", gap: space.md, minHeight: control.md, paddingHorizontal: space.lg, paddingVertical: space.md,
    borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
  },
  linkTitle: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold },
  linkSub: { color: colors.muted, fontSize: type.subhead, marginTop: 2, ...mono },
  chartHead: { flexDirection: "row", alignItems: "flex-end", gap: space.md },
  chartTotal: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold, marginTop: space.xs, ...mono },
  selDay: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium },
  selValue: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.semibold, marginTop: 2, ...mono },
  chart: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, height: 152 },
  col: { flex: 1, alignItems: "center", gap: space.sm },
  barTrack: { height: 120, width: "100%", justifyContent: "flex-end", alignItems: "center" },
  bar: { width: "78%", maxWidth: 34, borderRadius: radius.sm },
  dayLabel: { color: colors.muted, fontSize: type.caption, fontWeight: weight.medium, textTransform: "capitalize" },
  dayLabelSel: { color: colors.fg, fontWeight: weight.semibold },
  upcoming: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, minHeight: control.md },
  upValue: { color: colors.fg, fontSize: type.headline, fontWeight: weight.bold, ...mono },
  empty: { color: colors.muted, fontSize: type.body },
  ride: { flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingVertical: space.md },
  rideBorder: { borderTopWidth: 1, borderColor: colors.line },
  rideIcon: { marginTop: 1 },
  rideRoute: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold },
  rideMeta: { color: colors.muted, fontSize: type.footnote, ...mono },
  ridePrice: { color: colors.fg, fontSize: type.callout, fontWeight: weight.bold, ...mono },
  rideNet: { color: colors.muted, fontSize: type.footnote, marginTop: 2, ...mono },
  settle: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm, rowGap: space.xs, marginTop: space.xs },
  settleText: { color: colors.muted, fontSize: type.footnote, ...mono },
});
