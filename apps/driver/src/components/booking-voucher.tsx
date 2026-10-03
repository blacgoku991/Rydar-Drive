// Bon de réservation (§7.5, arrêté du 26 mars 2015) : UNE carte sur toutes les courses de l'app, propres et
// partenaires — organisation qui a pris la réservation, exploitant qui exécute, client (dans sa fenêtre pour une course
// partenaire), dates et lieu de prise en charge, « Reçu ou facture du client : délivré par {organisation} ».
// Repliée par défaut (la course d'abord) ; dépliée, elle se présente telle quelle lors d'un contrôle.
import { Ionicons } from "@expo/vector-icons";
import type { BookingVoucher } from "@rydar/shared";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { voucherView } from "@/lib/network";
import { colors, control, radius, space, type, weight } from "@/theme";

export function BookingVoucherCard({ voucher, tz }: { voucher: BookingVoucher; tz?: string }) {
  const [open, setOpen] = useState(false);
  const view = voucherView(voucher, tz);
  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Bon de réservation, à présenter en cas de contrôle"
        accessibilityHint={open ? "Masque le bon" : "Affiche le bon"}
      >
        <Ionicons name="document-text-outline" size={20} color={colors.muted} />
        <View style={styles.flex}>
          <Text style={styles.title}>Bon de réservation</Text>
          <Text style={styles.sub}>À présenter en cas de contrôle</Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={20} color={colors.muted} />
      </Pressable>
      {open && (
        <View style={styles.body}>
          {view.lines.map((line) => (
            <View key={line.key} style={styles.line} accessible accessibilityLabel={`${line.label} : ${line.value}`}>
              <Text style={styles.label}>{line.label}</Text>
              <Text style={styles.value} selectable>{line.value}</Text>
            </View>
          ))}
          <Text style={styles.receipt}>{view.receipt}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: control.md, paddingHorizontal: space.lg, paddingVertical: space.sm },
  pressed: { backgroundColor: colors.surface3 },
  flex: { flex: 1 },
  title: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  sub: { color: colors.muted, fontSize: type.footnote, marginTop: 2 },
  body: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.md },
  line: { gap: 2 },
  label: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  value: { color: colors.fg, fontSize: type.body, lineHeight: 21 },
  receipt: { color: colors.fg, fontSize: type.body, lineHeight: 21, fontWeight: weight.medium },
});
