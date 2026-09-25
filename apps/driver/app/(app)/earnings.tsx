// Gains du chauffeur : jour / semaine / mois, histogramme 7 jours, dernières courses (driver_earnings).
import { Ionicons } from "@expo/vector-icons";
import {
  PAYMENT_METHOD_LABELS, formatDistance, formatDuration, formatPrice, formatRideDate, type DriverEarnings, type EarningsPeriod, type PaymentMethod,
} from "@rydar/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Card, Label, Screen, ScreenHeader, Segmented } from "@/components/ui";
import { api } from "@/lib/api";
import { colors, mono } from "@/theme";

type Period = "today" | "week" | "month";

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

function periodTitle(p: Period, e: DriverEarnings) {
  if (p === "today") return "Aujourd'hui";
  if (p === "week") return "Cette semaine";
  const month = new Intl.DateTimeFormat("fr-FR", { month: "long", timeZone: e.timezone }).format(new Date(e.month.from));
  return `${month.charAt(0).toUpperCase()}${month.slice(1)}`;
}

export default function Earnings() {
  const [data, setData] = useState<DriverEarnings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("today");
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.earnings(7));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const p: EarningsPeriod | null = data ? data[period] : null;
  const currency = data?.currency ?? "EUR";
  const commission = data?.commission_percent ?? null;
  const series = data?.series ?? [];
  const max = useMemo(() => Math.max(1, ...series.map((d) => d.revenue_cents)), [series]);
  const today = series.length - 1;
  const sel = selectedDay ?? today;
  const selDay = series[sel];
  const weekTotal = series.reduce((s, d) => s + d.revenue_cents, 0);

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ScreenHeader title="Mes gains" />
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 48 }}
          refreshControl={
            <RefreshControl
              tintColor={colors.brand}
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
              {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.brand} />}
            </View>
          ) : (
            <>
              {/* Montant de la période */}
              <View style={styles.hero}>
                <Text style={styles.heroLabel}>{periodTitle(period, data)}</Text>
                <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={`Chiffre d'affaires ${formatPrice(p.revenue_cents, currency)}`}>
                  {formatPrice(p.revenue_cents, currency)}
                </Text>
                <View style={styles.stats}>
                  <Stat icon="car-sport-outline" value={`${p.rides}`} label={p.rides > 1 ? "courses" : "course"} />
                  <View style={styles.statSep} />
                  <Stat icon="navigate-outline" value={formatDistance(p.distance_m)} label="parcourus" />
                  <View style={styles.statSep} />
                  <Stat icon="time-outline" value={formatDuration(p.duration_s)} label="en course" />
                </View>
                {commission != null && p.net_cents != null && (
                  <View style={styles.net}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.netLabel}>Net estimé</Text>
                      <Text style={styles.netHint}>après commission de {String(commission).replace(".", ",")} %</Text>
                    </View>
                    <Text style={styles.netValue}>{formatPrice(p.net_cents, currency)}</Text>
                  </View>
                )}
                {(p.cash_cents > 0 || p.unpriced_rides > 0) && (
                  <View style={styles.notes}>
                    {p.cash_cents > 0 && (
                      <View style={styles.note}>
                        <Ionicons name="cash-outline" size={14} color={colors.amber} />
                        <Text style={styles.noteText}>dont {formatPrice(p.cash_cents, currency)} en espèces</Text>
                      </View>
                    )}
                    {p.unpriced_rides > 0 && (
                      <View style={styles.note}>
                        <Ionicons name="help-circle-outline" size={14} color={colors.muted} />
                        <Text style={styles.noteText}>{p.unpriced_rides} course{p.unpriced_rides > 1 ? "s" : ""} sans prix</Text>
                      </View>
                    )}
                  </View>
                )}
              </View>

              {/* Histogramme 7 jours */}
              <Card style={{ gap: 14 }}>
                <View style={styles.chartHead}>
                  <View style={{ flex: 1 }}>
                    <Label>7 derniers jours</Label>
                    <Text style={styles.chartTotal}>{formatPrice(weekTotal, currency)}</Text>
                  </View>
                  {selDay && (
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.selDay}>{sel === today ? "Aujourd'hui" : dayLong(selDay.date)}</Text>
                      <Text style={styles.selValue}>
                        {formatPrice(selDay.revenue_cents, currency)} · {selDay.rides} course{selDay.rides > 1 ? "s" : ""}
                      </Text>
                    </View>
                  )}
                </View>
                <View style={styles.chart} accessibilityRole="image" accessibilityLabel={`Gains des 7 derniers jours : ${formatPrice(weekTotal, currency)}`}>
                  {series.map((d, i) => {
                    const h = d.revenue_cents > 0 ? Math.max(6, Math.round((d.revenue_cents / max) * 120)) : 4;
                    const isToday = i === today;
                    const isSel = i === sel;
                    return (
                      <Pressable key={d.date} style={styles.col} onPress={() => setSelectedDay(i)} accessibilityLabel={`${dayLong(d.date)} : ${formatPrice(d.revenue_cents, currency)}`}>
                        <View style={styles.barTrack}>
                          <View
                            style={[
                              styles.bar,
                              {
                                height: h,
                                backgroundColor: d.revenue_cents === 0 ? colors.surface3 : colors.brand,
                                opacity: d.revenue_cents === 0 ? 1 : isSel || isToday ? 1 : 0.32,
                              },
                              isSel && d.revenue_cents > 0 && styles.barSel,
                            ]}
                          />
                        </View>
                        <Text style={[styles.dayLabel, (isToday || isSel) && { color: isToday ? colors.brand : colors.fg }]}>{isToday ? "auj." : weekday(d.date)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </Card>

              {data.upcoming.rides > 0 && (
                <Card style={styles.upcoming}>
                  <View style={styles.upIcon}>
                    <Ionicons name="calendar" size={18} color={colors.violet} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.upTitle}>À venir</Text>
                    <Text style={styles.upSub}>{data.upcoming.rides} course{data.upcoming.rides > 1 ? "s" : ""} acceptée{data.upcoming.rides > 1 ? "s" : ""}</Text>
                  </View>
                  <Text style={styles.upValue}>{formatPrice(data.upcoming.revenue_cents, currency)}</Text>
                </Card>
              )}

              <Label style={{ marginTop: 6 }}>Dernières courses</Label>
              {data.recent.length === 0 ? (
                <Text style={styles.empty}>Aucune course terminée pour le moment.</Text>
              ) : (
                <Card style={{ paddingVertical: 4, paddingHorizontal: 14 }}>
                  {data.recent.map((r, i) => (
                    <View key={r.id} style={[styles.ride, i > 0 && styles.rideBorder]}>
                      <View style={styles.rideIcon}>
                        <Ionicons name={PAY_ICON[r.payment_method] ?? "card-outline"} size={17} color={colors.muted} />
                      </View>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.rideRoute} numberOfLines={1}>{r.pickup} → {r.dropoff}</Text>
                        <Text style={styles.rideMeta} numberOfLines={1}>
                          #{r.number} · {formatRideDate(r.completed_at, data.timezone)} · {PAYMENT_METHOD_LABELS[r.payment_method] ?? ""}
                        </Text>
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={styles.ridePrice}>{formatPrice(r.price_cents, r.currency)}</Text>
                        {r.net_cents != null && <Text style={styles.rideNet}>net {formatPrice(r.net_cents, r.currency)}</Text>}
                      </View>
                    </View>
                  ))}
                </Card>
              )}
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

function Stat({ icon, value, label }: { icon: keyof typeof Ionicons.glyphMap; value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Ionicons name={icon} size={16} color={colors.subtle} />
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 80, alignItems: "center" },
  error: { color: colors.red, fontSize: 15, textAlign: "center" },
  hero: {
    borderRadius: 26, padding: 20, gap: 14, backgroundColor: colors.surface, borderWidth: 1, borderColor: "rgba(200,240,60,0.22)",
  },
  heroLabel: { color: colors.muted, fontSize: 14, fontWeight: "700" },
  amount: { color: colors.brand, fontSize: 58, fontWeight: "900", letterSpacing: -2, marginTop: -6, ...mono },
  stats: { flexDirection: "row", alignItems: "center" },
  stat: { flex: 1, alignItems: "center", gap: 3 },
  statSep: { width: 1, height: 38, backgroundColor: colors.line },
  statValue: { color: colors.fg, fontSize: 18, fontWeight: "900", ...mono },
  statLabel: { color: colors.subtle, fontSize: 12, fontWeight: "600" },
  net: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 16, backgroundColor: colors.surface2 },
  netLabel: { color: colors.fg, fontSize: 15, fontWeight: "800" },
  netHint: { color: colors.subtle, fontSize: 12.5, marginTop: 2 },
  netValue: { color: colors.fg, fontSize: 22, fontWeight: "900", ...mono },
  notes: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  note: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.surface2 },
  noteText: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  chartHead: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  chartTotal: { color: colors.fg, fontSize: 22, fontWeight: "900", marginTop: 4, ...mono },
  selDay: { color: colors.subtle, fontSize: 12.5, fontWeight: "700" },
  selValue: { color: colors.fg, fontSize: 14, fontWeight: "800", marginTop: 2, ...mono },
  chart: { flexDirection: "row", alignItems: "flex-end", gap: 8, height: 150 },
  col: { flex: 1, alignItems: "center", gap: 8 },
  barTrack: { height: 120, width: "100%", justifyContent: "flex-end", alignItems: "center" },
  bar: { width: "78%", maxWidth: 34, borderRadius: 8 },
  barSel: { shadowColor: colors.brand, shadowOpacity: 0.55, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } },
  dayLabel: { color: colors.subtle, fontSize: 11.5, fontWeight: "700", textTransform: "capitalize" },
  upcoming: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14 },
  upIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(179,157,250,0.14)", alignItems: "center", justifyContent: "center" },
  upTitle: { color: colors.fg, fontSize: 15, fontWeight: "800" },
  upSub: { color: colors.subtle, fontSize: 13, marginTop: 1 },
  upValue: { color: colors.violet, fontSize: 18, fontWeight: "900", ...mono },
  empty: { color: colors.subtle, fontSize: 14 },
  ride: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  rideBorder: { borderTopWidth: 1, borderColor: colors.line },
  rideIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  rideRoute: { color: colors.fg, fontSize: 15, fontWeight: "700" },
  rideMeta: { color: colors.subtle, fontSize: 12.5 },
  ridePrice: { color: colors.fg, fontSize: 16, fontWeight: "900", ...mono },
  rideNet: { color: colors.subtle, fontSize: 12, marginTop: 1, ...mono },
});
