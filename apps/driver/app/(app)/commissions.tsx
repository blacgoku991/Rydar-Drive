// Commissions (mode centrale) : ce que le chauffeur doit à la centrale (courses encaissées : commission +
// frais) et ce qu'elle lui doit (courses payées en ligne : sa part). Paiement par lien prérempli
// (Revolut, PayPal…), espèces ou virement → « J'ai payé » (driver_declare_payment), confirmé ou contesté
// par la centrale. Temps réel settlement.updated (driver:{id}) → relecture.
import { Ionicons } from "@expo/vector-icons";
import {
  PAYMENT_METHOD_LABELS, SETTLEMENT_METHOD_META, SETTLEMENT_STATUS_META, formatPrice, formatRideDate,
  type DriverSettlementItem, type DriverSettlements, type SettlementMethod,
} from "@rydar/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { blockerInfo, driverSettlementLabel, dueText, formatWhen, frTypo } from "@/components/centrale";
import { BigButton, BottomSheet, hapticResult, Screen, ScreenHeader, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useAppEvent } from "@/lib/events";
import { settlementSession } from "@/lib/settlement-session";
import { colors, mono, toneColor } from "@/theme";

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

const METHOD_TITLE: Record<Exclude<SettlementMethod, "link">, string> = { cash: "Paiement en espèces", transfer: "Paiement par virement" };
const METHOD_BUTTON: Record<Exclude<SettlementMethod, "link">, string> = { cash: "J'ai payé en espèces", transfer: "J'ai payé par virement" };

export default function Commissions() {
  const { home, refresh } = useDriver();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 64);
  const now = useNow(30_000);
  const [data, setData] = useState<DriverSettlements | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
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

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ScreenHeader title="Commissions" />
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 48 }}
          refreshControl={
            <RefreshControl
              tintColor={colors.brand}
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
              {error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.brand} />}
            </View>
          ) : data.model !== "centrale" ? (
            <View style={styles.empty}>
              <Ionicons name="wallet-outline" size={40} color={colors.subtle} />
              <Text style={styles.emptyTitle}>Pas de commission à régler</Text>
              <Text style={styles.emptyText}>Votre centrale ne fonctionne pas à la commission.</Text>
            </View>
          ) : (
            <>
              {/* Courses bloquées : commission en retard / contestée, plafond d'encours */}
              {blocked && (
                <View style={styles.blocked} accessibilityRole="alert">
                  <View style={styles.blockedIcon}>
                    <Ionicons name="lock-closed" size={22} color={colors.red} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.blockedTitle}>Courses bloquées</Text>
                    <Text style={styles.blockedText}>{blocked.message}</Text>
                  </View>
                </View>
              )}

              {owed > 0 ? (
                <View style={[styles.hero, { borderColor: late ? "rgba(242,85,90,0.45)" : "rgba(245,181,68,0.35)" }]}>
                  <Text style={styles.heroLabel} numberOfLines={1}>À régler à {orgName}</Text>
                  <Text style={[styles.heroAmount, { color: late ? colors.red : colors.amber }]} numberOfLines={1} adjustsFontSizeToFit>
                    {price(owed)}
                  </Text>
                  <View style={styles.refRow}>
                    <Text style={styles.heroMeta}>
                      {pay.count} course{pay.count > 1 ? "s" : ""}
                      {pay.reference ? " · réf. " : ""}
                    </Text>
                    {pay.reference ? (
                      <Pressable
                        onPress={() => void copyReference(pay.reference)}
                        style={({ pressed }) => [styles.refChip, pressed && { opacity: 0.7 }]}
                        accessibilityRole="button"
                        accessibilityLabel={`Copier la référence ${pay.reference}`}
                      >
                        <Text style={styles.refChipText} selectable>{pay.reference}</Text>
                        <Ionicons name="copy-outline" size={15} color={colors.fg} />
                      </Pressable>
                    ) : null}
                  </View>
                  <View style={styles.dueRow}>
                    <Ionicons name={late ? "alert-circle" : "time-outline"} size={17} color={late ? colors.red : colors.muted} />
                    <Text style={[styles.dueText, late && { color: colors.red }]}>
                      {disputed.length > 0
                        ? frTypo(`La centrale n'a pas reçu votre paiement de ${price(disputed.reduce((s, i) => s + i.amount_cents, 0))} : réglez-le de nouveau pour recevoir des courses`)
                        : late
                        ? frTypo(`${price(data.summary.overdue_cents)} en retard : réglez maintenant pour recevoir des courses`)
                        : data.summary.next_due_at
                          ? dueText(data.summary.next_due_at, tz, now).text
                          : `À régler dans les ${data.grace_hours} h après chaque course`}
                    </Text>
                  </View>

                  <View style={{ gap: 10, marginTop: 4 }}>
                    {canLink ? (
                      <BigButton title={`Payer ${price(owed)}`} icon="open-outline" height={66} onPress={() => void payByLink()} />
                    ) : null}
                    {manual.map((m, i) => (
                      <BigButton
                        key={m}
                        title={METHOD_BUTTON[m]}
                        icon={SETTLEMENT_METHOD_META[m].ionicon as keyof typeof Ionicons.glyphMap}
                        variant={!canLink && i === 0 ? "primary" : "secondary"}
                        height={canLink ? 54 : 62}
                        onPress={() => payManually(m)}
                      />
                    ))}
                  </View>
                </View>
              ) : data.summary.declared_cents > 0 ? (
                // Tout est signalé payé : reste la confirmation par la centrale
                <View style={[styles.hero, styles.heroOk, styles.heroWaiting]}>
                  <View style={[styles.okIcon, { backgroundColor: "rgba(106,166,255,0.14)" }]}>
                    <Ionicons name="time" size={30} color={colors.blue} />
                  </View>
                  <Text style={styles.okTitle}>Paiement signalé</Text>
                  <Text style={styles.okText}>
                    {price(data.summary.declared_cents)} en attente de confirmation par {orgName}. Vous serez prévenu dès sa validation.
                  </Text>
                </View>
              ) : (
                <View style={[styles.hero, styles.heroOk]}>
                  <View style={styles.okIcon}>
                    <Ionicons name="checkmark" size={30} color={colors.green} />
                  </View>
                  <Text style={styles.okTitle}>Tout est réglé</Text>
                  <Text style={styles.okText}>
                    Aucune commission à régler à {orgName}.
                    {data.summary.to_receive_cents > 0 ? ` ${price(data.summary.to_receive_cents)} de gains à recevoir.` : ""}
                  </Text>
                </View>
              )}

              {/* Synthèse */}
              <View style={styles.tiles}>
                <Tile
                  label="En retard"
                  value={price(data.summary.overdue_cents)}
                  hint={data.summary.overdue_cents > 0 ? "bloque les courses" : "aucun retard"}
                  color={data.summary.overdue_cents > 0 ? colors.red : colors.muted}
                  icon="alert-circle-outline"
                />
                <Tile
                  label="Signalé payé"
                  value={price(data.summary.declared_cents)}
                  hint="à confirmer"
                  color={data.summary.declared_cents > 0 ? colors.blue : colors.muted}
                  icon="time-outline"
                />
                <Tile
                  label="À recevoir"
                  value={price(data.summary.to_receive_cents)}
                  hint="courses payées en ligne"
                  color={data.summary.to_receive_cents > 0 ? colors.green : colors.muted}
                  icon="arrow-down-circle-outline"
                />
                <Tile
                  label="Réglé ce mois"
                  value={price(data.summary.paid_month_cents)}
                  hint={data.summary.received_month_cents > 0 ? `${price(data.summary.received_month_cents)} reçus` : "confirmées"}
                  color={colors.fg}
                  icon="checkmark-done-outline"
                />
              </View>

              {/* Règlements */}
              {data.items.length === 0 ? (
                <Text style={styles.footnote}>Les commissions apparaissent ici après chaque course terminée.</Text>
              ) : (
                <>
                  {open.length > 0 && <Text style={styles.section}>En cours · {open.length}</Text>}
                  {open.map((item) => (
                    <SettlementRow key={item.id} item={item} tz={tz} now={now} />
                  ))}
                  {closed.length > 0 && <Text style={styles.section}>Historique</Text>}
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
                Moyens acceptés : {pay.methods.map((m) => SETTLEMENT_METHOD_META[m].label.toLowerCase()).join(", ") || "voir avec la centrale"}
                {` · délai de ${data.grace_hours} h après chaque course encaissée.`}
              </Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>

      {flash.node}

      {/* « Avez-vous payé ? » au retour du lien de paiement ; espèces / virement : instructions + référence */}
      <BottomSheet visible={sheet != null} onClose={() => !busy && setSheet(null)} dismissable={!busy}>
        {sheet && (
          <>
            <View style={styles.sheetHead}>
              <View style={[styles.sheetIcon, { backgroundColor: "rgba(200,240,60,0.12)" }]}>
                <Ionicons
                  name={sheet.kind === "link" ? "help-circle" : (SETTLEMENT_METHOD_META[sheet.method].ionicon as keyof typeof Ionicons.glyphMap)}
                  size={26}
                  color={colors.brand}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetTitle}>{sheet.kind === "link" ? `Avez-vous payé ${price(sheet.amount)} ?` : METHOD_TITLE[sheet.method]}</Text>
                <Text style={styles.sheetSub}>
                  {sheet.kind === "link"
                    ? frTypo("Si le paiement est passé (Revolut, PayPal…), confirmez : la centrale le vérifiera.")
                    : sheet.method === "cash"
                      ? `Remettez ${price(sheet.amount)} en main propre à ${orgName}, puis confirmez.`
                      : `Faites un virement de ${price(sheet.amount)} à ${orgName} avec la référence, puis confirmez.`}
                </Text>
              </View>
            </View>

            {sheet.kind === "manual" && (
              <Text style={styles.sheetAmount} accessibilityLabel={`Montant ${price(sheet.amount)}`}>{price(sheet.amount)}</Text>
            )}
            {sheet.reference ? (
              <Pressable
                onPress={() => void copyReference(sheet.reference)}
                style={({ pressed }) => [styles.refBox, pressed && { opacity: 0.8 }]}
                accessibilityRole="button"
                accessibilityLabel={`Copier la référence ${sheet.reference}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.refLabel}>Référence à indiquer</Text>
                  <Text style={styles.refValue} selectable>{sheet.reference}</Text>
                </View>
                <View style={styles.copyBtn}>
                  <Ionicons name="copy-outline" size={18} color={colors.brandFg} />
                  <Text style={styles.copyText}>Copier</Text>
                </View>
              </Pressable>
            ) : null}
            {data?.pay.instructions ? (
              <View style={styles.instructions}>
                <Ionicons name="information-circle-outline" size={18} color={colors.blue} />
                <Text style={styles.instructionsText}>{data.pay.instructions}</Text>
              </View>
            ) : null}
            {sheet.kind === "manual" && (
              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder={sheet.method === "cash" ? "Note pour la centrale (ex. remis à Mehdi)" : "Note pour la centrale (facultatif)"}
                placeholderTextColor={colors.subtle}
                maxLength={300}
                style={styles.noteInput}
                accessibilityLabel="Note pour la centrale"
              />
            )}

            <BigButton
              title={sheet.kind === "link" ? `Oui, j'ai payé ${price(sheet.amount)}` : `Je confirme avoir payé ${price(sheet.amount)}`}
              icon="checkmark-circle"
              height={62}
              loading={busy}
              onPress={() => void declare(sheet)}
            />
            {sheet.kind === "link" && data?.pay.link ? (
              <BigButton title="Rouvrir le lien de paiement" icon="open-outline" variant="secondary" height={50} disabled={busy} onPress={() => void Linking.openURL(data.pay.link!).catch(() => null)} />
            ) : null}
            <BigButton title={sheet.kind === "link" ? "Pas encore" : "Annuler"} variant="ghost" height={46} disabled={busy} onPress={() => setSheet(null)} />
          </>
        )}
      </BottomSheet>
    </Screen>
  );
}

function Tile({ label, value, hint, color, icon }: { label: string; value: string; hint: string; color: string; icon: keyof typeof Ionicons.glyphMap }) {
  return (
    <View style={styles.tile}>
      <View style={styles.tileHead}>
        <Ionicons name={icon} size={15} color={color} />
        <Text style={styles.tileLabel} numberOfLines={1}>{label}</Text>
      </View>
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
  const amountColor = settled ? colors.muted : owes ? (overdue || item.status === "disputed" ? colors.red : colors.amber) : colors.green;
  const currency = item.currency ?? "EUR";

  let detail: string | null = null;
  if (item.status === "due") detail = owes ? dueText(item.due_at, tz, now).short : `Versement prévu d'ici ${formatWhen(item.due_at, tz)}`;
  else if (item.status === "declared") {
    const how = item.declared_method ? SETTLEMENT_METHOD_META[item.declared_method].label.toLowerCase() : null;
    detail = `${pastWhen(item.declared_at, tz).replace(/^./, (c) => c.toUpperCase())}${how ? ` (${how})` : ""} · à confirmer par la centrale`;
  } else if (item.status === "paid") detail = `${owes ? "Réglé" : "Versé"} ${pastWhen(item.settled_at, tz)}`;
  else if (item.status === "waived") detail = item.note ? `Annulé : ${item.note}` : "Annulé par la centrale";

  return (
    <View
      style={[compact ? styles.rowCompact : styles.row, compact && !first && styles.rowBorder, !compact && (overdue || item.status === "disputed") && { borderColor: "rgba(242,85,90,0.4)" }]}
      accessibilityLabel={`Course ${item.ride.number}, ${owes ? "commission" : "part à recevoir"} ${formatPrice(item.amount_cents, currency)}, ${label}`}
    >
      <View style={styles.rowHead}>
        <View style={[styles.rowIcon, { backgroundColor: `${owes ? colors.amber : colors.green}1A` }]}>
          <Ionicons name={owes ? "arrow-up" : "arrow-down"} size={17} color={settled ? colors.muted : owes ? colors.amber : colors.green} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            Course #{item.ride.number}
            <Text style={styles.rowKind}>  ·  {owes ? "commission" : "votre part"}</Text>
          </Text>
          <Text style={styles.rowRoute} numberOfLines={1}>{item.ride.pickup} → {item.ride.dropoff}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {formatRideDate(item.ride.completed_at ?? item.created_at, tz)} · {formatPrice(item.price_cents, currency)} · {PAYMENT_METHOD_LABELS[item.payment_method] ?? ""}
          </Text>
        </View>
        <Text style={[styles.rowAmount, { color: amountColor }, settled && styles.rowAmountSettled]}>
          {owes ? "−" : "+"}{formatPrice(item.amount_cents, currency)}
        </Text>
      </View>
      <View style={styles.rowFoot}>
        <View style={[styles.pill, { backgroundColor: `${tone}1F` }]}>
          <View style={[styles.pillDot, { backgroundColor: tone }]} />
          <Text style={[styles.pillText, { color: tone }]}>{label}</Text>
        </View>
        {detail ? <Text style={[styles.rowDetail, overdue && { color: colors.red }]} numberOfLines={2}>{detail}</Text> : null}
      </View>
      {item.status === "disputed" ? (
        <View style={styles.dispute}>
          <Ionicons name="chatbox-ellipses-outline" size={16} color={colors.red} />
          <Text style={styles.disputeText}>
            <Text style={{ fontWeight: "900" }}>La centrale n&apos;a pas reçu ce paiement{item.note ? " : " : "."}</Text>
            {frTypo(item.note ?? "")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 80, alignItems: "center" },
  error: { color: colors.red, fontSize: 15, textAlign: "center" },
  empty: { alignItems: "center", gap: 10, paddingVertical: 60 },
  emptyTitle: { color: colors.fg, fontSize: 19, fontWeight: "900" },
  emptyText: { color: colors.muted, fontSize: 14.5, textAlign: "center" },
  blocked: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 20, backgroundColor: "rgba(242,85,90,0.13)", borderWidth: 1, borderColor: "rgba(242,85,90,0.45)" },
  blockedIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: "rgba(242,85,90,0.18)", alignItems: "center", justifyContent: "center" },
  blockedTitle: { color: colors.red, fontSize: 16, fontWeight: "900" },
  blockedText: { color: colors.fg, fontSize: 14, lineHeight: 19, marginTop: 2, fontWeight: "600" },
  hero: { borderRadius: 26, padding: 20, gap: 10, backgroundColor: colors.surface, borderWidth: 1 },
  heroOk: { alignItems: "center", borderColor: "rgba(79,213,143,0.3)", paddingVertical: 26 },
  heroLabel: { color: colors.muted, fontSize: 13.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.6 },
  heroAmount: { fontSize: 60, fontWeight: "900", letterSpacing: -2, marginTop: -4, ...mono },
  heroMeta: { color: colors.muted, fontSize: 14.5, fontWeight: "700" },
  refRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4, marginTop: -4 },
  refChip: { flexDirection: "row", alignItems: "center", gap: 6, height: 30, paddingHorizontal: 10, borderRadius: 15, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.lineStrong },
  refChipText: { color: colors.fg, fontSize: 14, fontWeight: "900", letterSpacing: 0.5, ...mono },
  dueRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dueText: { flex: 1, color: colors.muted, fontSize: 14, fontWeight: "700", lineHeight: 19 },
  heroWaiting: { borderColor: "rgba(106,166,255,0.35)" },
  okIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: "rgba(79,213,143,0.14)", alignItems: "center", justifyContent: "center" },
  okTitle: { color: colors.fg, fontSize: 22, fontWeight: "900" },
  okText: { color: colors.muted, fontSize: 14.5, textAlign: "center", lineHeight: 20 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: { flexBasis: "47%", flexGrow: 1, padding: 14, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 4 },
  tileHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  tileLabel: { color: colors.muted, fontSize: 13, fontWeight: "800" },
  tileValue: { fontSize: 24, fontWeight: "900", ...mono },
  tileHint: { color: colors.subtle, fontSize: 12, fontWeight: "600" },
  section: { color: colors.subtle, fontSize: 13, fontWeight: "800", letterSpacing: 0.6, textTransform: "uppercase", marginTop: 6 },
  historyCard: { backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14 },
  row: { backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.line, padding: 14, gap: 10 },
  rowCompact: { paddingVertical: 12, gap: 8 },
  rowBorder: { borderTopWidth: 1, borderColor: colors.line },
  rowHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  rowIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", marginTop: 2 },
  rowTitle: { color: colors.fg, fontSize: 16, fontWeight: "900" },
  rowKind: { color: colors.subtle, fontSize: 13.5, fontWeight: "700" },
  rowRoute: { color: colors.fg, fontSize: 14.5, fontWeight: "600" },
  rowMeta: { color: colors.subtle, fontSize: 12.5 },
  rowAmount: { fontSize: 19, fontWeight: "900", ...mono },
  rowAmountSettled: { fontSize: 16 },
  rowFoot: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingLeft: 48 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99 },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { fontSize: 12.5, fontWeight: "900" },
  rowDetail: { flex: 1, minWidth: 140, color: colors.muted, fontSize: 13, fontWeight: "600" },
  dispute: { flexDirection: "row", gap: 8, padding: 12, borderRadius: 14, backgroundColor: "rgba(242,85,90,0.1)", marginLeft: 48 },
  disputeText: { flex: 1, color: colors.fg, fontSize: 14, lineHeight: 19 },
  footnote: { color: colors.subtle, fontSize: 12.5, textAlign: "center", marginTop: 4, paddingHorizontal: 14, lineHeight: 18 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sheetIcon: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  sheetTitle: { color: colors.fg, fontSize: 23, fontWeight: "900", letterSpacing: -0.3 },
  sheetSub: { color: colors.muted, fontSize: 14.5, marginTop: 4, lineHeight: 20 },
  sheetAmount: { color: colors.fg, fontSize: 48, fontWeight: "900", letterSpacing: -1.5, textAlign: "center", ...mono },
  refBox: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong },
  refLabel: { color: colors.subtle, fontSize: 12.5, fontWeight: "800" },
  refValue: { color: colors.fg, fontSize: 24, fontWeight: "900", letterSpacing: 1, marginTop: 2, ...mono },
  copyBtn: { flexDirection: "row", alignItems: "center", gap: 6, height: 42, paddingHorizontal: 14, borderRadius: 21, backgroundColor: colors.brand },
  copyText: { color: colors.brandFg, fontSize: 14.5, fontWeight: "900" },
  instructions: { flexDirection: "row", gap: 8, padding: 12, borderRadius: 14, backgroundColor: "rgba(106,166,255,0.1)" },
  instructionsText: { flex: 1, color: colors.fg, fontSize: 14, lineHeight: 19 },
  noteInput: { height: 52, borderRadius: 14, paddingHorizontal: 14, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, color: colors.fg, fontSize: 15.5 },
});
