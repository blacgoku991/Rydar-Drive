// Coordonnées bancaires du chauffeur (réseau partagé) : quand le client a déjà payé une course partenaire, l'organisation
// qui l'a confiée verse sa part au chauffeur par virement. L'IBAN n'est jamais réaffiché en entier (4 derniers
// caractères) : il se ressaisit pour être modifié. Suppression refusée tant qu'un versement est ouvert
// (PAYOUT_DETAILS_IN_USE). Chaque consultation par une organisation est notifiée au chauffeur (serveur).
import { Ionicons } from "@expo/vector-icons";
import { formatDate, type DriverPayoutInfo } from "@rydar/shared";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View, type TextInput } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { AuthField, FormScroll, Notice } from "@/components/auth";
import { frTypo } from "@/components/centrale";
import { BigButton, hapticResult, Screen, ScreenHeader, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { maskIban, payoutFormErrors, type PayoutForm } from "@/lib/network";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

type Errors = Partial<Record<keyof PayoutForm, string>>;

const CONSULTATION_NOTE = "Seules les organisations qui vous doivent un versement peuvent les consulter, et vous êtes prévenu à chaque consultation.";

export default function Payout() {
  const { network, refreshNetwork, home } = useDriver();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 64);
  const [info, setInfo] = useState<DriverPayoutInfo | null>(network?.payout ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PayoutForm>({ payee: "", iban: "", bic: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const ibanRef = useRef<TextInput>(null);
  const bicRef = useRef<TextInput>(null);
  const tz = home?.organization.timezone;

  const load = useCallback(async () => {
    try {
      setInfo(await api.payoutInfo());
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const configured = info?.configured ?? false;
  const showForm = editing || (info != null && !configured);

  function startEdit() {
    // Titulaire et BIC repris ; l'IBAN se ressaisit en entier (jamais renvoyé par le serveur)
    setForm({ payee: info?.payee_name ?? "", iban: "", bic: info?.bic ?? "" });
    setErrors({});
    setFailure(null);
    setEditing(true);
  }

  function set<K extends keyof PayoutForm>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function save() {
    if (busy) return;
    const found = payoutFormErrors(form);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) {
      if (found.iban) ibanRef.current?.focus();
      return;
    }
    setBusy("save");
    try {
      const res = await api.setPayoutDetails({ payee: form.payee, iban: form.iban, bic: form.bic });
      hapticResult(true);
      setInfo(res);
      setEditing(false);
      setForm({ payee: "", iban: "", bic: "" });
      flash.show("Coordonnées bancaires enregistrées");
      void refreshNetwork();
    } catch (e) {
      hapticResult(false);
      setFailure(frTypo((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  function remove() {
    if (busy || !info?.configured) return;
    Alert.alert(frTypo("Supprimer vos coordonnées bancaires ?"), frTypo("Les organisations partenaires ne pourront plus vous verser votre part par virement."), [
      { text: "Annuler", style: "cancel" },
      {
        text: "Supprimer",
        style: "destructive",
        onPress: async () => {
          setBusy("delete");
          setFailure(null);
          try {
            setInfo(await api.deletePayoutDetails());
            hapticResult(true);
            flash.show("Coordonnées bancaires supprimées");
            void refreshNetwork();
          } catch (e) {
            hapticResult(false);
            setFailure(frTypo((e as Error).message));
          } finally {
            setBusy(null);
          }
        },
      },
    ]);
  }

  return (
    <Screen>
      <SafeAreaView edges={["top", "bottom"]} style={styles.root}>
        <ScreenHeader title="Coordonnées bancaires" onBack={() => (router.canGoBack() ? router.back() : router.replace("/profile"))} />
        <FormScroll>
          <View style={styles.content}>
            <Text style={styles.lead}>
              {frTypo("Quand le client a déjà payé une course partenaire, l'organisation qui vous l'a confiée vous verse votre part par virement sur ce compte.")}
            </Text>

            {!info ? (
              <View style={styles.loading}>
                {loadError ? (
                  <>
                    <Text style={styles.error} accessibilityRole="alert">{loadError}</Text>
                    <BigButton title="Réessayer" variant="secondary" height={control.sm} onPress={() => void load()} style={{ alignSelf: "center", minWidth: 160 }} />
                  </>
                ) : (
                  <ActivityIndicator color={colors.muted} accessibilityLabel="Chargement des coordonnées bancaires" />
                )}
              </View>
            ) : showForm ? (
              <View style={styles.form}>
                <AuthField
                  label="Titulaire du compte"
                  icon="person-outline"
                  value={form.payee}
                  onChangeText={(v) => set("payee", v)}
                  error={errors.payee}
                  editable={busy == null}
                  autoCapitalize="words"
                  autoComplete="name"
                  textContentType="name"
                  returnKeyType="next"
                  maxLength={120}
                  onSubmitEditing={() => ibanRef.current?.focus()}
                />
                <AuthField
                  ref={ibanRef}
                  label="IBAN"
                  icon="card-outline"
                  help={configured ? "Saisissez l'IBAN en entier : l'ancien n'est jamais réaffiché." : null}
                  value={form.iban}
                  onChangeText={(v) => set("iban", v)}
                  error={errors.iban}
                  editable={busy == null}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  returnKeyType="next"
                  maxLength={42}
                  inputStyle={mono}
                  onSubmitEditing={() => bicRef.current?.focus()}
                />
                <AuthField
                  ref={bicRef}
                  label="BIC (facultatif)"
                  icon="business-outline"
                  value={form.bic}
                  onChangeText={(v) => set("bic", v)}
                  error={errors.bic}
                  editable={busy == null}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  autoComplete="off"
                  returnKeyType="done"
                  maxLength={11}
                  inputStyle={mono}
                  onSubmitEditing={() => void save()}
                />
                <View style={styles.notice}>
                  <Ionicons name="shield-checkmark-outline" size={20} color={colors.muted} />
                  <Text style={styles.noticeText}>{CONSULTATION_NOTE}</Text>
                </View>
                {failure && <Notice tone="error" message={failure} />}
                <View style={styles.actions}>
                  <BigButton title="Enregistrer" icon="checkmark" height={control.lg} loading={busy === "save"} disabled={busy != null} onPress={() => void save()} />
                  {configured && (
                    <BigButton title="Annuler" variant="ghost" height={control.md} disabled={busy != null} onPress={() => setEditing(false)} />
                  )}
                </View>
              </View>
            ) : (
              <>
                <View style={styles.card} accessible accessibilityLabel={`Titulaire ${info.payee_name ?? ""}, IBAN se terminant par ${info.iban_last4 ?? ""}${info.bic ? `, BIC ${info.bic}` : ""}`}>
                  <Row label="Titulaire" value={info.payee_name ?? "—"} />
                  <Row label="IBAN" value={maskIban(info.iban_last4)} mono />
                  {info.bic ? <Row label="BIC" value={info.bic} mono /> : null}
                  {info.updated_at ? <Text style={styles.updated}>Modifiées le {formatDate(info.updated_at, tz)}</Text> : null}
                </View>
                <View style={styles.notice}>
                  <Ionicons name="shield-checkmark-outline" size={20} color={colors.muted} />
                  <Text style={styles.noticeText}>{CONSULTATION_NOTE}</Text>
                </View>
                {failure && <Notice tone="error" message={failure} />}
                <View style={styles.actions}>
                  <BigButton title="Modifier" icon="create-outline" variant="secondary" height={control.md} disabled={busy != null} onPress={startEdit} />
                  <BigButton
                    title="Supprimer"
                    icon="trash-outline"
                    variant="ghost"
                    height={control.md}
                    loading={busy === "delete"}
                    disabled={busy != null || info.in_use}
                    onPress={remove}
                  />
                  {info.in_use && (
                    <Text style={styles.hint}>{frTypo("Un versement vous est encore dû : vous pourrez les supprimer une fois payé. Vous pouvez les modifier.")}</Text>
                  )}
                </View>
              </>
            )}
          </View>
        </FormScroll>
      </SafeAreaView>
      {flash.node}
    </Screen>
  );
}

function Row({ label, value, mono: tabular }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, tabular && mono]} selectable>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg, gap: space.lg },
  lead: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  loading: { paddingVertical: 60, alignItems: "center", gap: space.lg },
  error: { color: colors.red, fontSize: type.body, textAlign: "center", lineHeight: 21 },
  form: { gap: space.lg },
  actions: { gap: space.sm, marginTop: space.xs },
  card: { padding: space.lg, gap: space.md, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  row: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md },
  rowLabel: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.semibold },
  rowValue: { flexShrink: 1, color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold, textAlign: "right" },
  updated: { color: colors.muted, fontSize: type.footnote },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  noticeText: { flex: 1, color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  hint: { color: colors.muted, fontSize: type.footnote, lineHeight: 18, textAlign: "center" },
});
