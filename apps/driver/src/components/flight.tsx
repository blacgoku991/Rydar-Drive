// Vol associé à une course : carte (statut, heure, terminal, retard) et bandeau de prise en charge décalée.
import { Ionicons } from "@expo/vector-icons";
import { FLIGHT_STATUS_META, flightCode, formatDelay, formatTime, type Ride } from "@rydar/shared";
import { StyleSheet, Text, View } from "react-native";
import { colors, toneColor } from "@/theme";

type FlightRide = Pick<Ride, "flight_number" | "pickup_at"> & Partial<Pick<Ride,
  "flight_mode" | "flight_status" | "flight_scheduled_arrival" | "flight_estimated_arrival" | "flight_actual_arrival" |
  "flight_terminal" | "flight_origin" | "flight_delay_minutes" | "pickup_at_original">>;

const minutesBetween = (a?: string | null, b?: string | null) => (a && b ? Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60000) : 0);

/** ✈ AF1234 · de Rome — Arrivée estimée 14:52 · T2E · +35 min, avec le statut du vol. */
export function FlightCard({ ride, tz }: { ride: FlightRide; tz?: string }) {
  const code = flightCode(ride.flight_number);
  if (!code) return null;
  const status = ride.flight_status ?? null;
  const meta = status ? FLIGHT_STATUS_META[status] : null;
  const color = meta ? toneColor(meta.tone) : colors.cyan;
  const departure = ride.flight_mode === "departure";
  const landed = status === "landed";
  const estimated = ride.flight_estimated_arrival ?? null;
  const scheduled = ride.flight_scheduled_arrival ?? null;
  const time = landed ? ride.flight_actual_arrival ?? estimated ?? scheduled : estimated ?? scheduled;
  const label = departure
    ? estimated ? "Départ estimé" : "Départ prévu"
    : landed ? "Atterri à" : estimated ? "Arrivée estimée" : "Arrivée prévue";
  const delay = ride.flight_delay_minutes ?? null;
  const showDelay = delay != null && Math.abs(delay) >= 5 && status !== "cancelled" && status !== "diverted";
  const shifted = !landed && estimated && scheduled && Math.abs(minutesBetween(estimated, scheduled)) >= 5;
  const terminal = ride.flight_terminal ? `T${ride.flight_terminal.replace(/^T/i, "")}` : null;
  const place = ride.flight_origin ? `${departure ? "vers" : "de"} ${ride.flight_origin}` : departure ? "Vol au départ" : "Vol à l'arrivée";

  return (
    <View style={[styles.card, { borderColor: `${color}40` }]} accessibilityLabel={`Vol ${code}${meta ? `, ${meta.label}` : ""}`}>
      <View style={styles.head}>
        <View style={[styles.icon, { backgroundColor: `${color}1F` }]}>
          <Ionicons name="airplane" size={20} color={color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.code}>{code}</Text>
          <Text style={styles.place} numberOfLines={1}>{place}</Text>
        </View>
        <View style={[styles.status, { backgroundColor: `${color}1F` }]}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={[styles.statusText, { color }]}>{meta?.label ?? "Suivi du vol"}</Text>
        </View>
      </View>
      {status === "cancelled" ? (
        <Text style={styles.alert}>Vol annulé — attendez les consignes de la centrale.</Text>
      ) : status === "diverted" ? (
        <Text style={styles.alert}>Vol dérouté — attendez les consignes de la centrale.</Text>
      ) : time ? (
        <View style={styles.line}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.time}>{formatTime(time, tz)}</Text>
            {shifted && scheduled ? (
              <Text style={styles.wasLine}>
                prévu <Text style={styles.was}>{formatTime(scheduled, tz)}</Text>
              </Text>
            ) : null}
          </View>
          {terminal && (
            <View style={styles.box}>
              <Text style={styles.boxLabel}>Terminal</Text>
              <Text style={styles.boxValue}>{terminal}</Text>
            </View>
          )}
          {showDelay && (
            <View style={[styles.box, { backgroundColor: delay! > 0 ? "rgba(245,181,68,0.14)" : "rgba(106,166,255,0.14)" }]}>
              <Text style={styles.boxLabel}>{delay! > 0 ? "Retard" : "Avance"}</Text>
              <Text style={[styles.boxValue, { color: delay! > 0 ? colors.amber : colors.blue }]}>{formatDelay(delay)}</Text>
            </View>
          )}
        </View>
      ) : (
        <Text style={styles.label}>Horaires en cours de récupération…</Text>
      )}
    </View>
  );
}

/** « Prise en charge décalée à 15:20 (vol retardé) — au lieu de 14:45 » quand le suivi du vol a déplacé l'heure. */
export function PickupShiftBanner({ ride, tz }: { ride: FlightRide; tz?: string }) {
  const original = ride.pickup_at_original ?? null;
  if (!original || Math.abs(minutesBetween(ride.pickup_at, original)) < 1) return null;
  const later = minutesBetween(ride.pickup_at, original) > 0;
  const delay = ride.flight_delay_minutes ?? 0;
  const reason = delay >= 5 ? "vol retardé" : delay <= -5 ? "vol en avance" : "horaire du vol";
  const color = later ? colors.amber : colors.blue;
  return (
    <View style={[styles.banner, { backgroundColor: `${color}17`, borderColor: `${color}4D` }]} accessibilityLiveRegion="polite">
      <Ionicons name="time" size={22} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle}>
          Prise en charge décalée à <Text style={{ color }}>{formatTime(ride.pickup_at, tz)}</Text> ({reason})
        </Text>
        <Text style={styles.bannerSub}>
          heure demandée <Text style={{ textDecorationLine: "line-through" }}>{formatTime(original, tz)}</Text>
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 18, borderWidth: 1, backgroundColor: colors.surface2, padding: 14, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  code: { color: colors.fg, fontSize: 18, fontWeight: "900", letterSpacing: 0.5, fontVariant: ["tabular-nums"] },
  place: { color: colors.subtle, fontSize: 13, marginTop: 1 },
  status: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12.5, fontWeight: "800" },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { color: colors.subtle, fontSize: 12.5, fontWeight: "700" },
  time: { color: colors.fg, fontSize: 24, fontWeight: "900", fontVariant: ["tabular-nums"], marginTop: 1 },
  wasLine: { color: colors.subtle, fontSize: 12.5, fontWeight: "600", marginTop: 1 },
  was: { textDecorationLine: "line-through", fontVariant: ["tabular-nums"] },
  box: { alignItems: "center", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: colors.surface3, minWidth: 64 },
  boxLabel: { color: colors.subtle, fontSize: 11, fontWeight: "700" },
  boxValue: { color: colors.fg, fontSize: 16, fontWeight: "900", fontVariant: ["tabular-nums"] },
  alert: { color: colors.red, fontSize: 14.5, fontWeight: "700" },
  banner: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 16, borderWidth: 1 },
  bannerTitle: { color: colors.fg, fontSize: 15.5, fontWeight: "800", lineHeight: 21 },
  bannerSub: { color: colors.muted, fontSize: 13, marginTop: 2 },
});
