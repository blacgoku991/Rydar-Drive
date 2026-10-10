// Agenda (Flotte Privée), bloc « À traiter » : carte d'une réservation de son site encore sans chauffeur, et feuille
// « Annuler la réservation » (motif de 3 à 280 caractères). Textes et couleurs : lib/agenda-view.ts (todoCardView).
// À confirmer : Confirmer et Refuser (56 px), Appeler le client (48 px). Non confirmée, à vérifier ou refusée : La
// prendre (56 px), Annuler la réservation, Appeler le client.
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from "react-native";
import { frTypo } from "@/components/centrale";
import { BigButton, BottomSheet, Card, Pill, RouteLine } from "@/components/ui";
import { CANCEL_REASON_MAX, cancelReasonError, routeText, type TodoCard, type TodoCardView } from "@/lib/agenda-view";
import { colors, control, mono, radius, space, toneColor, type, weight } from "@/theme";

export function BookingCard({
  card, view, highlighted, busy, disabled, onConfirm, onDecline, onTake, onCancel, onCall, onLayout,
}: {
  card: TodoCard;
  view: TodoCardView;
  /** Réservation mise en avant (notification « non confirmée », élément touché dans le calendrier) */
  highlighted: boolean;
  /** Action en cours sur cette carte */
  busy: boolean;
  /** Action en cours sur une autre carte */
  disabled: boolean;
  onConfirm: () => void;
  onDecline: () => void;
  onTake: () => void;
  onCancel: () => void;
  onCall: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const toConfirm = card.state === "to_confirm";
  const muted = view.muted;
  return (
    <View onLayout={onLayout}>
      <Card style={[styles.card, highlighted && styles.highlighted]}>
        <View accessible accessibilityLabel={view.a11y} style={styles.info}>
          <View style={styles.head}>
            <Pill label={view.stateLabel} color={toneColor(view.stateTone)} />
            <Text style={[styles.price, muted && styles.muted]}>{view.price}</Text>
          </View>
          <View style={{ gap: 2 }}>
            <Text style={[styles.when, muted && styles.muted]}>
              {view.when}
              {view.relative ? <Text style={styles.relative}>{` · ${view.relative}`}</Text> : null}
            </Text>
            <Text style={styles.meta}>{view.meta}</Text>
          </View>
          <RouteLine from={card.pickupAddress} to={card.dropoffAddress} />
          {view.customer && (
            <View style={styles.line}>
              <Ionicons name="person-outline" size={18} color={colors.muted} />
              <Text style={styles.lineText} numberOfLines={1}>{view.customer}</Text>
            </View>
          )}
          {view.answerBefore && (
            <View style={styles.line}>
              <Ionicons name="time-outline" size={18} color={colors.amber} />
              <Text style={[styles.lineText, styles.deadline]}>{view.answerBefore}</Text>
            </View>
          )}
          {view.warnings.map((w) => (
            <View key={w} style={styles.line}>
              <Ionicons name="warning-outline" size={18} color={colors.amber} />
              <Text style={styles.lineText}>{w}</Text>
            </View>
          ))}
        </View>

        {toConfirm ? (
          <View style={styles.row}>
            <BigButton
              title="Confirmer"
              height={control.md}
              onPress={onConfirm}
              loading={busy}
              disabled={disabled}
              style={styles.flex}
              accessibilityLabel={`Confirmer la réservation ${card.number}`}
            />
            <BigButton
              title="Refuser"
              variant="secondary"
              height={control.md}
              onPress={onDecline}
              disabled={busy || disabled}
              style={styles.flex}
              accessibilityLabel={`Refuser la réservation ${card.number}`}
            />
          </View>
        ) : (
          <>
            {view.takeable && (
              <BigButton
                title="La prendre"
                height={control.md}
                onPress={onTake}
                loading={busy}
                disabled={disabled}
                accessibilityLabel={`Prendre la réservation ${card.number}`}
              />
            )}
            <BigButton
              title="Annuler la réservation"
              variant="danger"
              height={control.sm}
              onPress={onCancel}
              disabled={busy || disabled}
              accessibilityLabel={`Annuler la réservation ${card.number}`}
            />
          </>
        )}
        {card.customerPhone && (
          <BigButton
            title="Appeler le client"
            icon="call-outline"
            variant="secondary"
            height={control.sm}
            onPress={onCall}
            accessibilityLabel={view.customer ? `Appeler le client, ${view.customer}` : "Appeler le client"}
          />
        )}
      </Card>
    </View>
  );
}

/**
 * « Annuler la réservation » : motif obligatoire (3 à 280 caractères, transmis au site par le webhook ride.cancelled).
 * `onSubmit` renvoie le message d'erreur à afficher, ou null (annulée : la feuille se ferme).
 */
export function CancelBookingSheet({
  target, onClose, onSubmit,
}: {
  target: { rideId: string; number: number; pickupAddress: string; dropoffAddress: string } | null;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<string | null>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setReason("");
    setError(null);
  }, [target?.rideId]);

  async function submit() {
    if (busy) return;
    const invalid = cancelReasonError(reason);
    setError(invalid);
    if (invalid) return;
    setBusy(true);
    try {
      const failure = await onSubmit(reason.trim());
      if (failure) setError(frTypo(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet visible={target != null} onClose={() => !busy && onClose()} keyboard>
      <Text style={styles.sheetTitle} accessibilityRole="header">
        Annuler la réservation {target ? <Text style={mono}>{target.number}</Text> : null}
      </Text>
      {target && <Text style={styles.sheetRoute} numberOfLines={1}>{routeText(target.pickupAddress, target.dropoffAddress)}</Text>}
      <Text style={styles.sheetHint}>{frTypo("Motif transmis à votre site : 3 à 280 caractères.")}</Text>
      <TextInput
        value={reason}
        onChangeText={(t) => {
          setReason(t);
          if (error) setError(null);
        }}
        placeholder="Motif de l'annulation"
        placeholderTextColor={colors.muted}
        multiline
        maxLength={CANCEL_REASON_MAX + 20}
        editable={!busy}
        style={[styles.input, error && styles.inputError]}
        accessibilityLabel="Motif de l'annulation"
        accessibilityHint="3 à 280 caractères"
      />
      <View style={styles.counterRow}>
        {error ? <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="polite">{error}</Text> : <View style={styles.flex} />}
        <Text style={[styles.counter, reason.trim().length > CANCEL_REASON_MAX && { color: colors.red }]}>
          {reason.trim().length}/{CANCEL_REASON_MAX}
        </Text>
      </View>
      <BigButton title="Annuler la réservation" variant="danger" icon="close-circle-outline" height={control.md} loading={busy} onPress={() => void submit()} />
      <BigButton title="Retour" variant="ghost" height={control.sm} disabled={busy} onPress={onClose} />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.md },
  highlighted: { borderColor: colors.amber, borderWidth: 1.5 },
  info: { gap: space.md },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  price: { color: colors.fg, fontSize: type.headline, fontWeight: weight.bold, ...mono },
  when: { color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold, ...mono },
  relative: { color: colors.muted, fontWeight: weight.medium },
  meta: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.medium, ...mono },
  muted: { color: colors.muted },
  line: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  lineText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 20 },
  deadline: { fontWeight: weight.semibold, ...mono },
  row: { flexDirection: "row", gap: space.sm },
  flex: { flex: 1 },
  sheetTitle: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold },
  sheetRoute: { color: colors.muted, fontSize: type.subhead },
  sheetHint: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  input: {
    minHeight: 96, maxHeight: 160, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.bg,
    color: colors.fg, fontSize: type.body, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.md, textAlignVertical: "top",
  },
  inputError: { borderColor: colors.red },
  counterRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  error: { flex: 1, color: colors.red, fontSize: type.subhead, lineHeight: 20 },
  counter: { color: colors.muted, fontSize: type.footnote, ...mono },
});
