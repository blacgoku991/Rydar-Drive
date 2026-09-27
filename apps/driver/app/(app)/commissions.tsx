// Commissions (mode centrale) : ce que le chauffeur doit à la centrale (courses encaissées : commission +
// frais) et ce qu'elle lui doit (courses payées en ligne : sa part). Paiement par lien prérempli
// (Revolut, PayPal…), espèces ou virement → « J'ai payé » (driver_declare_payment), confirmé ou contesté
// par la centrale. Temps réel settlement.updated (driver:{id}) → relecture.
import { Ionicons } from "@expo/vector-icons";
import {
  PAYMENT_METHOD_LABELS, SETTLEMENT_METHOD_META, SETTLEMENT_STATUS_META, formatIban, formatPrice, formatRideDate,
  type DriverSettlementItem, type DriverSettlements, type SettlementMethod,
} from "@rydar/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { blockerInfo, driverSettlementLabel, dueText, formatWhen, frTypo } from "@/components/centrale";
import { BigButton, BottomSheet, hapticResult, Label, Pill, Screen, ScreenHeader, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useAppEvent } from "@/lib/events";
import { settlementSession } from "@/lib/settlement-session";
import { colors, control, mono, radius, space, toneColor, type, weight } from "@/theme";

const NBSP = "\u00A0";

/** Montants figés au moment du paiement : un règlement créé entre-temps n'est pas déclaré payé par erreur. */
type PaySnapshot = { amount: number; ids: string[]; reference: string | null };
type SheetState =
  | ({ kind: "link" } & PaySnapshot)
  | ({ kind: "manual"; method: Exclude<SettlementMethod, "link"> } & PaySnapshot);

/** « aujourd'hui 14:32 », « hier 22:10 », « le jeu. 25/09 06:30 » */
function pastWhen(iso: string | null | undefined, tz?: string) {
  if (!iso) return "";
  const s = formatRideDate(iso, tz);
  if (/^(Aujourd'hui|Hier|Demain) /.test(s)) return `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  return `le ${s}`;
}

const plural = (n: number, one: string, many: string) => `${n}${NBSP}${n > 1 ? many : one}`;

const METHOD_TITLE: Record<Exclude<SettlementMethod, "link">, string> = {
  transfer: "Paiement par virement",
  cash: "Paiement en espèces",
  other: "Autre moyen de paiement",
};
const METHOD_BUTTON: Record<Exclude<SettlementMethod, "link">, string> = {
  transfer: "J'ai payé par virement",
  cash: "J'ai payé en espèces",
  other: "J'ai payé (autre moyen)",
};

export default function Commissions() {
  const { home, refresh } = useDriver();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 64);
  const now = useNow(30_000);
  const [data, setData] = useState<DriverSettlements | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const tz = home?.organization.timezone;

  const load = useCallback(async () => {
    try {
      setData(await api.settlements(50));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  // Écran affiché : une notification « commission » le rafraîchit au lieu d'en ouvrir un second
  useFocusEffect(
    useCallback(() => {
      settlementSession.open = true;
      void load();
      return () => {
        settlementSession.open = false;
      };
    }, [load]),
  );
  // Commission créée, paiement confirmé ou contesté par la centrale (temps réel / notification)
  useAppEvent("settlements", () => void load());

  const currency = data?.currency ?? "EUR";
  const price = (c: number | null | undefined) => formatPrice(c, currency);

  async function copyReference(ref: string | null) {
    if (!ref) return;
    const res = await copyText(ref);
    if (res === "copied") flash.show(`Référence ${ref} copiée`);
    else if (res === "failed") flash.show(frTypo(`Copie impossible : notez la référence ${ref}.`), "error");
  }

  async function copyIban(iban: string) {
    const res = await copyText(iban);
    if (res === "copied") flash.show("IBAN copié");
    else if (res === "failed") flash.show(frTypo(`Copie impossible : notez l'IBAN ${formatIban(iban)}.`), "error");
  }

  function snapshot(): PaySnapshot | null {
    if (!data || data.pay.amount_cents <= 0 || data.pay.settlement_ids.length === 0) return null;
    return { amount: data.pay.amount_cents, ids: [...data.pay.settlement_ids], reference: data.pay.reference };
  }

  async function payByLink() {
    const snap = snapshot();
    if (!snap || !data?.pay.link) return;
    const opened = await Linking.openURL(data.pay.link).then(() => true).catch(() => false);
    if (!opened) flash.show(frTypo("Impossible d'ouvrir le lien de paiement : payez par un autre moyen."), "error");
    // Retour dans l'app : « Avez-vous payé ? »
    setSheet({ kind: "link", ...snap });
  }

  function payManually(method: Exclude<SettlementMethod, "link">) {
    const snap = snapshot();
    if (!snap) return;
    setNote("");
    setSheet({ kind: "manual", method, ...snap });
  }

  async function declare(s: SheetState) {
    setBusy(true);
    try {
      const res = await api.declarePayment(s.ids, s.kind === "link" ? "link" : s.method, s.kind === "manual" ? note : null);
      hapticResult(res.ok);
      if (!res.ok) {
        flash.show(frTypo(res.message ?? "Déclaration impossible. Réessayez."), "error");
        await load();
        return;
      }
      setSheet(null);
      flash.show(frTypo(res.message ?? "Paiement signalé : la centrale va le confirmer."));
      await Promise.all([load(), refresh()]);
    } catch (e) {
      hapticResult(false);
      flash.show((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const pay = data?.pay;
  const owed = pay?.amount_cents ?? 0;
  const blocked = blockerInfo(data?.blocked, data?.blocked_message);
  const late = (data?.summary.overdue_cents ?? 0) > 0;
  // Paiement signalé puis contesté par la centrale (« Non reçu ») : à régler de nouveau
  const disputed = data?.items.filter((i) => i.direction === "driver_owes" && i.status === "disputed") ?? [];
  const canLink = !!pay?.link && pay.methods.includes("link");
  const manual = (pay?.methods ?? []).filter((m): m is Exclude<SettlementMethod, "link"> => m !== "link");
  const orgName = data?.organization.name ?? home?.organization.name ?? "la centrale";
  const open = data?.items.filter((i) => ["due", "declared", "disputed"].includes(i.status)) ?? [];
  const closed = data?.items.filter((i) => !["due", "declared", "disputed"].includes(i.status)) ?? [];
  const dueLine = !data
    ? ""
    : disputed.length > 0
      ? frTypo(`La centrale n'a pas reçu votre paiement de ${price(disputed.reduce((s, i) => s + i.amount_cents, 0))} : réglez-le de nouveau pour recevoir des courses`)
      : late
        ? frTypo(`${price(data.summary.overdue_cents)} en retard : réglez maintenant pour recevoir des courses`)
        : data.summary.next_due_at
          ? dueText(data.summary.next_due_at, tz, now).text
          : `À régler dans les ${data.grace_hours}${NBSP}h après chaque course`;
  const urgent = late || disputed.length > 0;

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ScreenHeader title="Commissions" />
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              tintColor={colors.muted}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await Promise.all([load(), refresh()]);
                setRefreshing(false);
              }}
            />
          }
        >
          {!data || !pay ? (
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
                <ActivityIndicator color={colors.muted} accessibilityLabel="Chargement des commissions" />
              )}
            </View>
          ) : data.model !== "centrale" ? (
            <View style={styles.empty}>
              <Ionicons name="wallet-outline" size={32} color={colors.muted} />
              <Text style={styles.emptyTitle}>Pas de commission à régler</Text>
              <Text style={styles.emptyText}>Votre centrale ne fonctionne pas à la commission.</Text>
            </View>
          ) : (
            <>
              {/* Courses bloquées : commission en retard / contestée, plafond d'encours */}
              {blocked && (
                <View style={styles.card} accessibilityRole="alert" accessible accessibilityLabel={`Courses bloquées. ${blocked.message}`}>
                  <View style={styles.cardRow}>
                    <Ionicons name="lock-closed-outline" size={22} color={colors.red} style={styles.leadIcon} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.cardTitle, { color: colors.red }]}>Courses bloquées</Text>
                      <Text style={styles.cardText}>{blocked.message}</Text>
                    </View>
                  </View>
                </View>
              )}

              {owed > 0 ? (
                <View style={styles.hero}>
                  <Text style={styles.heroLabel} numberOfLines={1}>À régler à {orgName}</Text>
                  <Text
                    style={[styles.heroAmount, urgent && { color: colors.red }]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    accessibilityLabel={`${price(owed)} à régler`}
                  >
                    {price(owed)}
                  </Text>
                  <View style={styles.refRow}>
                    <Text style={styles.heroMeta}>
                      {plural(pay.count, "course", "courses")}
                      {pay.reference ? " · référence" : ""}
                    </Text>
                    {pay.reference ? (
                      <Pressable
                        onPress={() => void copyReference(pay.reference)}
                        style={({ pressed }) => [styles.refChip, pressed && { backgroundColor: colors.surface3 }]}
                        accessibilityRole="button"
                        accessibilityLabel={`Copier la référence ${pay.reference}`}
                      >
                        <Text style={styles.refChipText} selectable>{pay.reference}</Text>
                        <Ionicons name="copy-outline" size={18} color={colors.muted} />
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.dueRow}>
                    <Ionicons name={urgent ? "alert-circle-outline" : "time-outline"} size={20} color={urgent ? colors.red : colors.muted} />
                    <Text style={[styles.dueText, urgent && { color: colors.red }]}>{dueLine}</Text>
                  </View>

                  <View style={styles.actions}>
                    {canLink ? (
                      <BigButton title={`Payer ${price(owed)}`} icon="open-outline" height={control.lg} onPress={() => void payByLink()} />
                    ) : null}
                    {manual.map((m, i) => (
                      <BigButton
                        key={m}
                        title={METHOD_BUTTON[m]}
                        icon={SETTLEMENT_METHOD_META[m].ionicon as keyof typeof Ionicons.glyphMap}
                        variant={!canLink && i === 0 ? "primary" : "secondary"}
                        height={!canLink && i === 0 ? control.lg : control.md}
                        onPress={() => payManually(m)}
                      />
                    ))}
                  </View>
                </View>
              ) : data.summary.declared_cents > 0 ? (
                // Tout est signalé payé : reste la confirmation par la centrale
                <View style={styles.card}>
                  <View style={styles.cardRow}>
                    <Ionicons name="time-outline" size={22} color={colors.blue} style={styles.leadIcon} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>Paiement signalé</Text>
                      <Text style={styles.cardText}>
                        {price(data.summary.declared_cents)} en attente de confirmation par {orgName}. Vous serez prévenu dès sa validation.
                      </Text>
                    </View>
                  </View>
                </View>
              ) : (
                <View style={styles.card}>
                  <View style={styles.cardRow}>
                    <Ionicons name="checkmark-circle-outline" size={22} color={colors.green} style={styles.leadIcon} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cardTitle}>Tout est réglé</Text>
                      <Text style={styles.cardText}>
                        Aucune commission à régler à {orgName}.
                        {data.summary.to_receive_cents > 0 ? ` ${price(data.summary.to_receive_cents)} de gains à recevoir.` : ""}
                      </Text>
                    </View>
                  </View>
                </View>
              )}

              {/* Synthèse */}
              <View style={styles.tiles}>
                <Tile
                  label="En retard"
                  value={price(data.summary.overdue_cents)}
                  hint={data.summary.overdue_cents > 0 ? "Bloque les courses" : "Aucun retard"}
                  color={data.summary.overdue_cents > 0 ? colors.red : colors.muted}
                />
                <Tile
                  label="Signalé payé"
                  value={price(data.summary.declared_cents)}
                  hint="À confirmer"
                  color={data.summary.declared_cents > 0 ? colors.blue : colors.muted}
                />
                <Tile
                  label="À recevoir"
                  value={price(data.summary.to_receive_cents)}
                  hint="Courses payées en ligne"
                  color={data.summary.to_receive_cents > 0 ? colors.green : colors.muted}
                />
                <Tile
                  label="Réglé ce mois"
                  value={price(data.summary.paid_month_cents)}
                  hint={data.summary.received_month_cents > 0 ? `${price(data.summary.received_month_cents)} reçus` : "Confirmées"}
                  color={colors.fg}
                />
              </View>

              {/* Règlements */}
              {data.items.length === 0 ? (
                <Text style={styles.footnote}>Les commissions apparaissent ici après chaque course terminée.</Text>
              ) : (
                <>
                  {open.length > 0 && <Label style={styles.section}>En cours · {open.length}</Label>}
                  {open.map((item) => (
                    <SettlementRow key={item.id} item={item} tz={tz} now={now} />
                  ))}
                  {closed.length > 0 && <Label style={styles.section}>Historique</Label>}
                  {closed.length > 0 && (
                    <View style={styles.historyCard}>
                      {closed.map((item, i) => (
                        <SettlementRow key={item.id} item={item} tz={tz} now={now} compact first={i === 0} />
                      ))}
                    </View>
                  )}
                </>
              )}
              <Text style={styles.footnote}>
                {`Moyens acceptés${NBSP}: `}
                {pay.methods.map((m) => SETTLEMENT_METHOD_META[m].label.toLowerCase()).join(", ") || "voir avec la centrale"}
                {`. Délai de ${data.grace_hours}${NBSP}h après chaque course encaissée.`}
              </Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>

      {flash.node}

      {/* « Avez-vous payé ? » au retour du lien de paiement ; espèces / virement : instructions + référence */}
      <BottomSheet visible={sheet != null} onClose={() => !busy && setSheet(null)} dismissable={!busy} keyboard={sheet?.kind === "manual"}>
        {sheet && (
          <>
            <View style={{ gap: space.xs }}>
              <Text style={styles.sheetTitle} accessibilityRole="header">
                {sheet.kind === "link" ? `Avez-vous payé ${price(sheet.amount)}${NBSP}?` : METHOD_TITLE[sheet.method]}
              </Text>
              <Text style={styles.sheetSub}>
                {sheet.kind === "link"
                  ? frTypo("Si le paiement est passé (Revolut, PayPal…), confirmez : la centrale le vérifiera.")
                  : sheet.method === "cash"
                    ? `Remettez ${price(sheet.amount)} en main propre à ${orgName}, puis confirmez.`
                    : sheet.method === "transfer"
                      ? `Faites un virement de ${price(sheet.amount)} à ${data?.pay.bank?.payee_name ?? orgName} avec la référence, puis confirmez.`
                      : `Payez ${price(sheet.amount)} à ${orgName} comme indiqué ci-dessous, puis confirmez.`}
              </Text>
            </View>

            {sheet.kind === "manual" && (
              <Text style={styles.sheetAmount} accessibilityLabel={`Montant ${price(sheet.amount)}`}>{price(sheet.amount)}</Text>
            )}
            {sheet.reference ? (
              <Pressable
                onPress={() => void copyReference(sheet.reference)}
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
            {sheet.kind === "manual" && sheet.method === "transfer" && data?.pay.bank ? (
              <View style={styles.bank} accessible={false}>
                <View style={styles.bankRow}>
                  <Text style={styles.refLabel}>Bénéficiaire</Text>
                  <Text style={styles.bankValue} selectable>{data.pay.bank.payee_name}</Text>
                </View>
                <Pressable
                  onPress={() => void copyIban(data.pay.bank!.iban)}
                  style={({ pressed }) => [styles.bankIban, pressed && { backgroundColor: colors.surface3 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Copier l'IBAN ${formatIban(data.pay.bank.iban)}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.refLabel}>IBAN</Text>
                    <Text style={styles.ibanValue} selectable>{formatIban(data.pay.bank.iban)}</Text>
                  </View>
                  <View style={styles.copyBtn}>
                    <Ionicons name="copy-outline" size={18} color={colors.fg} />
                    <Text style={styles.copyText}>Copier</Text>
                  </View>
                </Pressable>
                {data.pay.bank.bic ? (
                  <View style={styles.bankRow}>
                    <Text style={styles.refLabel}>BIC</Text>
                    <Text style={[styles.bankValue, mono]} selectable>{data.pay.bank.bic}</Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {data?.pay.instructions ? (
              <View style={styles.instructions}>
                <Ionicons name="information-circle-outline" size={20} color={colors.muted} />
                <Text style={styles.instructionsText}>{data.pay.instructions}</Text>
              </View>
            ) : null}
            {sheet.kind === "manual" && (
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder={sheet.method === "cash" ? "Note pour la centrale (ex. remis à Mehdi)" : "Note pour la centrale (facultatif)"}
                placeholderTextColor={colors.muted}
                maxLength={300}
                editable={!busy}
                style={styles.noteInput}
                accessibilityLabel="Note pour la centrale"
              />
            )}

            <View style={{ gap: space.sm }}>
              <BigButton
                title={sheet.kind === "link" ? `Oui, j'ai payé ${price(sheet.amount)}` : `Je confirme avoir payé ${price(sheet.amount)}`}
                icon="checkmark"
                height={control.lg}
                loading={busy}
                onPress={() => void declare(sheet)}
              />
              {sheet.kind === "link" && data?.pay.link ? (
                <BigButton
                  title="Rouvrir le lien de paiement"
                  icon="open-outline"
                  variant="secondary"
                  height={control.md}
                  disabled={busy}
                  onPress={() => void Linking.openURL(data.pay.link!).catch(() => null)}
                />
              ) : null}
              <BigButton title={sheet.kind === "link" ? "Pas encore" : "Annuler"} variant="ghost" height={control.sm} disabled={busy} onPress={() => setSheet(null)} />
            </View>
          </>
        )}
      </BottomSheet>
    </Screen>
  );
}

function Tile({ label, value, hint, color }: { label: string; value: string; hint: string; color: string }) {
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${label}${NBSP}: ${value}, ${hint}`}>
      <Text style={styles.tileLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.tileValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={styles.tileHint} numberOfLines={1}>{hint}</Text>
    </View>
  );
}

function SettlementRow({ item, tz, now, compact, first }: { item: DriverSettlementItem; tz?: string; now: number; compact?: boolean; first?: boolean }) {
  const owes = item.direction === "driver_owes";
  const overdue = owes && item.status === "due" && (item.overdue || new Date(item.due_at).getTime() <= now);
  const tone = overdue ? colors.red : toneColor(SETTLEMENT_STATUS_META[item.status].tone);
  const label = driverSettlementLabel(item.status, item.direction, overdue);
  const settled = item.status === "paid" || item.status === "waived";
  const amountColor = settled ? colors.muted : overdue || item.status === "disputed" ? colors.red : colors.fg;
  const currency = item.currency ?? "EUR";

  let detail: string | null = null;
  if (item.status === "due") detail = owes ? dueText(item.due_at, tz, now).short : `Versement prévu d'ici ${formatWhen(item.due_at, tz)}`;
  else if (item.status === "declared") {
    const how = item.declared_method ? SETTLEMENT_METHOD_META[item.declared_method].label.toLowerCase() : null;
    detail = `${pastWhen(item.declared_at, tz).replace(/^./, (c) => c.toUpperCase())}${how ? ` (${how})` : ""} · à confirmer par la centrale`;
  } else if (item.status === "paid") detail = `${owes ? "Réglé" : "Versé"} ${pastWhen(item.settled_at, tz)}`;
  else if (item.status === "waived") detail = item.note ? frTypo(`Annulé : ${item.note}`) : "Annulé par la centrale";

  return (
    <View
      style={[compact ? styles.rowCompact : styles.row, compact && !first && styles.rowBorder]}
      accessible
      accessibilityLabel={`Course ${item.ride.number}, ${owes ? "commission" : "part à recevoir"} ${formatPrice(item.amount_cents, currency)}, ${label}${detail ? `, ${detail}` : ""}`}
    >
      <View style={styles.rowHead}>
        <Ionicons name={owes ? "arrow-up-outline" : "arrow-down-outline"} size={20} color={colors.muted} style={styles.rowIcon} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            Course {item.ride.number}
            <Text style={styles.rowKind}>{` · ${owes ? "commission" : "votre part"}`}</Text>
          </Text>
          <Text style={styles.rowRoute} numberOfLines={1}>{item.ride.pickup} → {item.ride.dropoff}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {formatRideDate(item.ride.completed_at ?? item.created_at, tz)} · {formatPrice(item.price_cents, currency)} · {PAYMENT_METHOD_LABELS[item.payment_method] ?? ""}
          </Text>
        </View>
        <Text style={[styles.rowAmount, { color: amountColor }]}>
          {owes ? "−" : "+"}{formatPrice(item.amount_cents, currency)}
        </Text>
      </View>
      <View style={styles.rowFoot}>
        <Pill label={label} color={tone} />
        {detail ? <Text style={[styles.rowDetail, overdue && { color: colors.red }]} numberOfLines={2}>{detail}</Text> : null}
      </View>
      {item.status === "disputed" ? (
        <View style={styles.dispute}>
          <Ionicons name="alert-circle-outline" size={20} color={colors.red} />
          <Text style={styles.disputeText}>
            <Text style={{ fontWeight: weight.semibold }}>{`La centrale n'a pas reçu ce paiement${item.note ? `${NBSP}: ` : "."}`}</Text>
            {frTypo(item.note ?? "")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: 48 },
  loading: { paddingVertical: 80, alignItems: "center", gap: space.lg },
  error: { color: colors.red, fontSize: type.body, textAlign: "center", lineHeight: 21 },
  empty: { alignItems: "center", gap: space.sm, paddingVertical: 60, paddingHorizontal: space.xl },
  emptyTitle: { color: colors.fg, fontSize: type.title3, fontWeight: weight.semibold, marginTop: space.xs },
  emptyText: { color: colors.muted, fontSize: type.body, textAlign: "center", lineHeight: 21 },
  card: { padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  cardRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  leadIcon: { marginTop: 1 },
  cardTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  cardText: { color: colors.muted, fontSize: type.body, lineHeight: 21, marginTop: 2 },
  hero: { borderRadius: radius.lg, padding: 20, gap: space.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  heroLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  heroAmount: { color: colors.fg, fontSize: type.display, fontWeight: weight.bold, letterSpacing: -0.5, marginTop: -space.xs, ...mono },
  heroMeta: { color: colors.muted, fontSize: type.body, ...mono },
  refRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm },
  refChip: {
    flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.sm,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong,
  },
  refChipText: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, letterSpacing: 0.5, ...mono },
  dueRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  dueText: { flex: 1, color: colors.muted, fontSize: type.body, lineHeight: 21, ...mono },
  actions: { gap: space.sm, marginTop: space.xs },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  tile: {
    flexBasis: "47%", flexGrow: 1, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 2,
  },
  tileLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  tileValue: { fontSize: type.title3, fontWeight: weight.bold, marginTop: 2, ...mono },
  tileHint: { color: colors.muted, fontSize: type.footnote },
  section: { marginTop: space.sm },
  historyCard: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.lg },
  row: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md },
  rowCompact: { paddingVertical: space.md, gap: space.sm },
  rowBorder: { borderTopWidth: 1, borderColor: colors.line },
  rowHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  rowIcon: { marginTop: 1 },
  rowTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold, ...mono },
  rowKind: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.regular },
  rowRoute: { color: colors.fg, fontSize: type.body },
  rowMeta: { color: colors.muted, fontSize: type.footnote, ...mono },
  rowAmount: { fontSize: type.headline, fontWeight: weight.bold, ...mono },
  rowFoot: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, paddingLeft: 32 },
  rowDetail: { flex: 1, minWidth: 140, color: colors.muted, fontSize: type.footnote, ...mono },
  dispute: {
    flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md,
    backgroundColor: colors.surface2, marginLeft: 32,
  },
  disputeText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
  footnote: { color: colors.muted, fontSize: type.footnote, marginTop: space.xs, lineHeight: 18 },
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
