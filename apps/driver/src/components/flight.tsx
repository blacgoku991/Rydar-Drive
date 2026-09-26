// Vol associé à une course : carte (statut, heure, terminal, retard) et bandeau de prise en charge décalée.
import { Ionicons } from "@expo/vector-icons";
import { FLIGHT_STATUS_META, flightCode, formatDelay, formatTime, type Ride } from "@rydar/shared";
import { StyleSheet, Text, View } from "react-native";
import { Pill } from "@/components/ui";
import { colors, mono, radius, space, toneColor, type, weight } from "@/theme";

type FlightRide = Pick<Ride, "flight_number" | "pickup_at"> & Partial<Pick<Ride,
  "flight_mode" | "flight_status" | "flight_scheduled_arrival" | "flight_estimated_arrival" | "flight_actual_arrival" |
  "flight_terminal" | "flight_origin" | "flight_delay_minutes" | "pickup_at_original">>;

const minutesBetween = (a?: string | null, b?: string | null) => (a && b ? Math.round((new Date(a).getTime() - new Date(b).getTime()) / 60000) : 0);

/** Vol AF1234 de Rome : arrivée estimée 14:52, terminal 2E, retard +35 min, avec le statut du vol. */
export function FlightCard({ ride, tz }: { ride: FlightRide; tz?: string }) {
  const code = flightCode(ride.flight_number);
  if (!code) return null;
  const status = ride.flight_status ?? null;
  const meta = status ? FLIGHT_STATUS_META[status] : null;
  const color = meta ? toneColor(meta.tone) : colors.muted;
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
  const place = ride.flight_origin ? `${departure ? "Vers" : "De"} ${ride.flight_origin}` : departure ? "Vol au départ" : "Vol à l'arrivée";

  return (
    <View style={styles.card} accessibilityLabel={`Vol ${code}${meta ? `, ${meta.label}` : ""}`}>
      <View style={styles.head}>
        <Ionicons name="airplane-outline" size={20} color={colors.muted} />
        <View style={{ flex: 1 }}>
          <Text style={styles.code}>{code}</Text>
          <Text style={styles.place} numberOfLines={1}>{place}</Text>
        </View>
        <View style={styles.status}>
          <Pill label={meta?.label ?? "Suivi du vol"} color={color} />
        </View>
      </View>
      {status === "cancelled" ? (
        <Text style={styles.alert} accessibilityRole="alert">Vol annulé. Attendez les consignes de la centrale.</Text>
      ) : status === "diverted" ? (
        <Text style={styles.alert} accessibilityRole="alert">Vol dérouté. Attendez les consignes de la centrale.</Text>
      ) : time ? (
        <View style={styles.line}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>{label}</Text>
            <Text style={styles.time}>{formatTime(time, tz)}</Text>
            {shifted && scheduled ? (
              <Text style={styles.wasLine}>
                Prévu <Text style={styles.was}>{formatTime(scheduled, tz)}</Text>
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
            <View style={styles.box}>
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

/** « Prise en charge décalée à 15:20 (vol retardé) », heure demandée 14:45, quand le suivi du vol a déplacé l'heure. */
export function PickupShiftBanner({ ride, tz }: { ride: FlightRide; tz?: string }) {
  const original = ride.pickup_at_original ?? null;
  if (!original || Math.abs(minutesBetween(ride.pickup_at, original)) < 1) return null;
  const later = minutesBetween(ride.pickup_at, original) > 0;
  const delay = ride.flight_delay_minutes ?? 0;
  const reason = delay >= 5 ? "vol retardé" : delay <= -5 ? "vol en avance" : "horaire du vol";
  const color = later ? colors.amber : colors.blue;
  return (
    <View style={styles.banner} accessibilityLiveRegion="polite">
      <Ionicons name="time-outline" size={20} color={colors.muted} style={styles.bannerIcon} />
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle}>
          Prise en charge décalée à <Text style={[styles.bannerTime, { color }]}>{formatTime(ride.pickup_at, tz)}</Text> ({reason})
        </Text>
        <Text style={styles.bannerSub}>
          Heure demandée <Text style={styles.was}>{formatTime(original, tz)}</Text>
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2, padding: space.lg, gap: space.md },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  code: { color: colors.fg, fontSize: type.headline, fontWeight: weight.bold, letterSpacing: 0.3, ...mono },
  place: { color: colors.muted, fontSize: type.body, marginTop: 1 },
  status: { alignSelf: "center" },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm },
  label: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium },
  time: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, marginTop: 1, ...mono },
  wasLine: { color: colors.muted, fontSize: type.footnote, marginTop: 1 },
  was: { textDecorationLine: "line-through", ...mono },
  box: { alignItems: "center", paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.md, backgroundColor: colors.surface3, minWidth: 68 },
  boxLabel: { color: colors.muted, fontSize: type.caption, fontWeight: weight.medium },
  boxValue: { color: colors.fg, fontSize: type.callout, fontWeight: weight.bold, ...mono },
  alert: { color: colors.red, fontSize: type.body, fontWeight: weight.semibold, lineHeight: 21 },
  banner: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface2,
  },
  bannerIcon: { marginTop: 1 },
  bannerTitle: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, lineHeight: 21 },
  bannerTime: { fontWeight: weight.bold, ...mono },
  bannerSub: { color: colors.muted, fontSize: type.subhead, marginTop: 2 },
});
