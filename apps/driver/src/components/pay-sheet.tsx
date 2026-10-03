// Feuille « J'ai payé » : retour du lien de paiement (« Avez-vous payé ? ») ou paiement en espèces / par virement /
// autre moyen (instructions, référence, RIB copiables, note). Commune aux commissions de la centrale et aux courses
// partenaires (chaque organisation avec SES moyens de paiement). Montants figés à l'ouverture : un règlement créé
// entre-temps n'est pas déclaré payé par erreur.
import { Ionicons } from "@expo/vector-icons";
import { formatIban, formatPrice, type SettlementBank, type SettlementMethod } from "@rydar/shared";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { frTypo } from "@/components/centrale";
import { BigButton, BottomSheet } from "@/components/ui";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

const NBSP = " ";

export type ManualMethod = Exclude<SettlementMethod, "link">;

/** Montants figés au moment du paiement. */
export type PaySnapshot = { amount: number; ids: string[]; reference: string | null };
export type PaySheetState = ({ kind: "link" } & PaySnapshot) | ({ kind: "manual"; method: ManualMethod } & PaySnapshot);

/** Organisation à payer et ses moyens. */
export type PayTarget = {
  /** Nom de l'organisation */
  name: string;
  /** Qui confirme le paiement : « la centrale », ou le nom de l'organisation partenaire */
  confirmer: string;
  link: string | null;
  bank: SettlementBank | null;
  instructions: string | null;
};

export const METHOD_TITLE: Record<ManualMethod, string> = {
  transfer: "Paiement par virement",
  cash: "Paiement en espèces",
  other: "Autre moyen de paiement",
};
export const METHOD_BUTTON: Record<ManualMethod, string> = {
  transfer: "J'ai payé par virement",
  cash: "J'ai payé en espèces",
  other: "J'ai payé (autre moyen)",
};

export function PaySheet({
  sheet, target, currency, busy, note, onNote, onClose, onConfirm, onCopyReference, onCopyIban,
}: {
  sheet: PaySheetState | null;
  target: PayTarget | null;
  currency: string;
  busy: boolean;
  note: string;
  onNote: (v: string) => void;
  onClose: () => void;
  onConfirm: (s: PaySheetState) => void;
  onCopyReference: (ref: string | null) => void;
  onCopyIban: (iban: string) => void;
}) {
  const price = (c: number) => formatPrice(c, currency);
  return (
    <BottomSheet visible={sheet != null} onClose={() => !busy && onClose()} dismissable={!busy} keyboard={sheet?.kind === "manual"}>
      {sheet && target && (
        <>
          <View style={{ gap: space.xs }}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              {sheet.kind === "link" ? `Avez-vous payé ${price(sheet.amount)}${NBSP}?` : METHOD_TITLE[sheet.method]}
            </Text>
            <Text style={styles.sheetSub}>
              {sheet.kind === "link"
                ? frTypo(`Si le paiement est passé (Revolut, PayPal…), confirmez : ${target.confirmer} le vérifiera.`)
                : sheet.method === "cash"
                  ? `Remettez ${price(sheet.amount)} en main propre à ${target.name}, puis confirmez.`
                  : sheet.method === "transfer"
                    ? `Faites un virement de ${price(sheet.amount)} à ${target.bank?.payee_name ?? target.name} avec la référence, puis confirmez.`
                    : `Payez ${price(sheet.amount)} à ${target.name} comme indiqué ci-dessous, puis confirmez.`}
            </Text>
          </View>

          {sheet.kind === "manual" && (
            <Text style={styles.sheetAmount} accessibilityLabel={`Montant ${price(sheet.amount)}`}>{price(sheet.amount)}</Text>
          )}
          {sheet.reference ? (
            <Pressable
              onPress={() => onCopyReference(sheet.reference)}
              style={({ pressed }) => [styles.refBox, pressed && { backgroundColor: colors.surface3 }]}
              accessibilityRole="button"
              accessibilityLabel={`Copier la référence ${sheet.reference}`}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.refLabel}>Référence à indiquer</Text>
                <Text style={styles.refValue} selectable>{sheet.reference}</Text>
              </View>
              <View style={styles.copyBtn}>
                <Ionicons name="copy-outline" size={18} color={colors.fg} />
                <Text style={styles.copyText}>Copier</Text>
              </View>
            </Pressable>
          ) : null}
          {sheet.kind === "manual" && sheet.method === "transfer" && target.bank ? (
            <View style={styles.bank} accessible={false}>
              <View style={styles.bankRow}>
                <Text style={styles.refLabel}>Bénéficiaire</Text>
                <Text style={styles.bankValue} selectable>{target.bank.payee_name}</Text>
              </View>
              <Pressable
                onPress={() => onCopyIban(target.bank!.iban)}
                style={({ pressed }) => [styles.bankIban, pressed && { backgroundColor: colors.surface3 }]}
                accessibilityRole="button"
                accessibilityLabel={`Copier l'IBAN ${formatIban(target.bank.iban)}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.refLabel}>IBAN</Text>
                  <Text style={styles.ibanValue} selectable>{formatIban(target.bank.iban)}</Text>
                </View>
                <View style={styles.copyBtn}>
                  <Ionicons name="copy-outline" size={18} color={colors.fg} />
                  <Text style={styles.copyText}>Copier</Text>
                </View>
              </Pressable>
              {target.bank.bic ? (
                <View style={styles.bankRow}>
                  <Text style={styles.refLabel}>BIC</Text>
                  <Text style={[styles.bankValue, mono]} selectable>{target.bank.bic}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
          {target.instructions ? (
            <View style={styles.instructions}>
              <Ionicons name="information-circle-outline" size={20} color={colors.muted} />
              <Text style={styles.instructionsText}>{target.instructions}</Text>
            </View>
          ) : null}
          {sheet.kind === "manual" && (
            <TextInput
              value={note}
              onChangeText={onNote}
              placeholder={sheet.method === "cash" ? `Note pour ${target.confirmer} (ex. remis à Mehdi)` : `Note pour ${target.confirmer} (facultatif)`}
              placeholderTextColor={colors.muted}
              maxLength={300}
              editable={!busy}
              style={styles.noteInput}
              accessibilityLabel={`Note pour ${target.confirmer}`}
            />
          )}

          <View style={{ gap: space.sm }}>
            <BigButton
              title={sheet.kind === "link" ? `Oui, j'ai payé ${price(sheet.amount)}` : `Je confirme avoir payé ${price(sheet.amount)}`}
              icon="checkmark"
              height={control.lg}
              loading={busy}
              onPress={() => onConfirm(sheet)}
            />
            {sheet.kind === "link" && target.link ? (
              <BigButton
                title="Rouvrir le lien de paiement"
                icon="open-outline"
                variant="secondary"
                height={control.md}
                disabled={busy}
                onPress={() => void Linking.openURL(target.link!).catch(() => null)}
              />
            ) : null}
            <BigButton title={sheet.kind === "link" ? "Pas encore" : "Annuler"} variant="ghost" height={control.sm} disabled={busy} onPress={onClose} />
          </View>
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheetTitle: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, ...mono },
  sheetSub: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  sheetAmount: { color: colors.fg, fontSize: type.display, fontWeight: weight.bold, letterSpacing: -0.5, ...mono },
  refBox: {
    flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, borderRadius: radius.md,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong,
  },
  refLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  refValue: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: 0.5, marginTop: 2, ...mono },
  copyBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, height: control.sm, paddingHorizontal: space.lg, borderRadius: radius.md,
    backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.lineStrong,
  },
  copyText: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold },
  bank: { gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong },
  bankRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md },
  bankValue: { flexShrink: 1, color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, textAlign: "right" },
  bankIban: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.xs, borderRadius: radius.sm },
  ibanValue: { color: colors.fg, fontSize: type.callout, fontWeight: weight.bold, marginTop: 2, ...mono },
  instructions: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface2 },
  instructionsText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
  noteInput: {
    height: control.md, borderRadius: radius.md, paddingHorizontal: space.lg, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
    color: colors.fg, fontSize: type.callout,
  },
});
