// « Courses partenaires » (écran Commissions) : un bloc par organisation qui a confié des courses au chauffeur, avec
// SES moyens de paiement (lien + domaine, virement + RIB copiable, espèces, autre + instructions), « J'ai payé »
// (driver_declare_network_payment, une organisation à la fois) et « Je conteste » (driver_dispute_network_settlement,
// une fois par ligne). Un seul montant par sens, jamais commission ni frais. Vues : src/lib/network.ts.
import { Ionicons } from "@expo/vector-icons";
import {
  SETTLEMENT_METHOD_META, formatPhone, formatPrice, type DriverNetworkSettlementItem, type DriverNetworkSettlements, type DriverPayoutInfo,
} from "@rydar/shared";
import { router } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { frTypo } from "@/components/centrale";
import { METHOD_BUTTON, PaySheet, type ManualMethod, type PaySheetState, type PayTarget } from "@/components/pay-sheet";
import { BigButton, BottomSheet, hapticResult, Label, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { creditorView, disputeReasonError, partnerItemView, type CreditorView, type ItemTone } from "@/lib/network";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

const NBSP = " ";
const plural = (n: number, one: string, many: string) => `${n}${NBSP}${n > 1 ? many : one}`;
const TONE: Record<ItemTone, string> = {
  amber: colors.amber, blue: colors.blue, green: colors.green, red: colors.red, muted: colors.muted,
};

type Flash = { show: (text: string, tone?: "success" | "error" | "info") => void };
type Dispute = { item: DriverNetworkSettlementItem; giver: string; label: string; prompt: string };

export function NetworkSettlementsView({
  data, tz, now, payout, onChanged, flash,
}: {
  data: DriverNetworkSettlements;
  tz?: string;
  now: number;
  payout: DriverPayoutInfo | null;
  onChanged: () => Promise<void>;
  flash: Flash;
}) {
  const [sheet, setSheet] = useState<{ org: CreditorView; state: PaySheetState; target: PayTarget } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [dispute, setDispute] = useState<Dispute | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const currency = data.currency || "EUR";
  const price = (c: number) => formatPrice(c, currency);
  const orgs = data.organizations.map((c) => ({ raw: c, view: creditorView(c, tz, now) }));
  const waitingPayout = orgs.some((o) => o.view.payout) && !payout?.configured;

  async function copyReference(ref: string | null) {
    if (!ref) return;
    const res = await copyText(ref);
    if (res === "copied") flash.show(`Référence ${ref} copiée`);
    else if (res === "failed") flash.show(frTypo(`Copie impossible : notez la référence ${ref}.`), "error");
  }
  async function copyIban(iban: string) {
    const res = await copyText(iban);
    if (res === "copied") flash.show("IBAN copié");
    else if (res === "failed") flash.show(frTypo("Copie impossible : notez l'IBAN."), "error");
  }

  function openPay(org: CreditorView, raw: DriverNetworkSettlements["organizations"][number], method: "link" | ManualMethod) {
    if (!org.pay) return;
    const snap = { amount: org.pay.amountCents, ids: [...org.pay.ids], reference: org.pay.reference };
    const target: PayTarget = {
      name: org.name, confirmer: org.name, link: org.pay.link, bank: raw.pay?.bank ?? null, instructions: raw.pay?.instructions ?? null,
    };
    setNote("");
    if (method === "link") {
      if (!org.pay.link) return;
      void Linking.openURL(org.pay.link)
        .then(() => true)
        .catch(() => false)
        .then((opened) => {
          if (!opened) flash.show(frTypo("Impossible d'ouvrir le lien de paiement : payez par un autre moyen."), "error");
          // Retour dans l'app : « Avez-vous payé ? »
          setSheet({ org, target, state: { kind: "link", ...snap } });
        });
      return;
    }
    setSheet({ org, target, state: { kind: "manual", method, ...snap } });
  }

  async function declare(s: PaySheetState) {
    if (!sheet) return;
    setBusy(true);
    try {
      const res = await api.declareNetworkPayment(sheet.org.id, s.ids, s.kind === "link" ? "link" : s.method, s.kind === "manual" ? note : null);
      hapticResult(res.ok);
      if (!res.ok) {
        flash.show(frTypo(res.message ?? "Déclaration impossible. Réessayez."), "error");
        await onChanged();
        return;
      }
      setSheet(null);
      flash.show(frTypo(res.message ?? `Paiement signalé : ${sheet.org.name} va le confirmer.`));
      await onChanged();
    } catch (e) {
      hapticResult(false);
      flash.show((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function sendDispute() {
    if (!dispute || busy) return;
    const err = disputeReasonError(reason);
    setReasonError(err && frTypo(err));
    if (err) return;
    setBusy(true);
    try {
      await api.disputeNetworkSettlement(dispute.item.id, reason);
      hapticResult(true);
      setDispute(null);
      flash.show(`Contestation envoyée à ${dispute.giver}`);
      await onChanged();
    } catch (e) {
      hapticResult(false);
      setReasonError(frTypo((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <View style={styles.tiles}>
        <Tile label="À régler" value={price(data.summary.owed_cents)} hint="Courses payées à bord" color={data.summary.owed_cents > 0 ? colors.amber : colors.muted} />
        <Tile label="En retard" value={price(data.summary.overdue_cents)} hint={data.summary.overdue_cents > 0 ? "À régler maintenant" : "Aucun retard"} color={data.summary.overdue_cents > 0 ? colors.red : colors.muted} />
        <Tile label="Signalé payé" value={price(data.summary.declared_cents)} hint="À confirmer" color={data.summary.declared_cents > 0 ? colors.blue : colors.muted} />
        <Tile
          label="À recevoir"
          value={price(data.summary.payout_due_cents)}
          hint={data.summary.on_hold_cents > 0 ? `+${NBSP}${price(data.summary.on_hold_cents)} à vérifier` : "Courses déjà payées"}
          color={data.summary.payout_due_cents > 0 ? colors.green : colors.muted}
        />
      </View>

      {waitingPayout && (
        <View style={styles.card}>
          <View style={styles.cardRow}>
            <Ionicons name="card-outline" size={22} color={colors.amber} style={styles.lead} />
            <View style={{ flex: 1, gap: space.sm }}>
              <Text style={styles.cardText}>{frTypo("Renseignez vos coordonnées bancaires : les organisations partenaires vous versent votre part par virement.")}</Text>
              <BigButton title="Renseigner" variant="secondary" height={control.sm} onPress={() => router.push("/payout")} style={{ alignSelf: "flex-start", minWidth: 160 }} />
            </View>
          </View>
        </View>
      )}

      {orgs.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="swap-horizontal-outline" size={32} color={colors.muted} />
          <Text style={styles.emptyTitle}>Aucune course partenaire</Text>
          <Text style={styles.emptyText}>
            {frTypo("Ce que vous devez aux organisations partenaires, ou ce qu'elles vous versent, apparaît ici après chaque course partenaire.")}
          </Text>
        </View>
      ) : (
        orgs.map(({ raw, view }) => (
          <OrganizationBlock
            key={view.id}
            org={view}
            currency={raw.currency || currency}
            tz={tz}
            now={now}
            onCopyReference={(r) => void copyReference(r)}
            onPay={(m) => openPay(view, raw, m)}
            onDispute={(item, label, prompt) => {
              setReason("");
              setReasonError(null);
              setDispute({ item, giver: view.name, label, prompt });
            }}
          />
        ))
      )}
      <Text style={styles.footnote}>
        {frTypo("Chaque organisation partenaire a ses moyens de paiement et son délai (48 h au moins). Un impayé envers une organisation ne bloque que ses courses.")}
      </Text>

      <PaySheet
        sheet={sheet?.state ?? null}
        target={sheet?.target ?? null}
        currency={currency}
        busy={busy}
        note={note}
        onNote={setNote}
        onClose={() => setSheet(null)}
        onConfirm={(s) => void declare(s)}
        onCopyReference={(r) => void copyReference(r)}
        onCopyIban={(i) => void copyIban(i)}
      />

      <BottomSheet visible={dispute != null} onClose={() => !busy && setDispute(null)} dismissable={!busy} keyboard>
        {dispute && (
          <>
            <View style={{ gap: space.xs }}>
              <Text style={styles.sheetTitle} accessibilityRole="header">{dispute.label}</Text>
              <Text style={styles.sheetSub}>{dispute.prompt}</Text>
            </View>
            <TextInput
              value={reason}
              onChangeText={(v) => {
                setReason(v);
                if (reasonError) setReasonError(null);
              }}
              placeholder="Votre explication"
              placeholderTextColor={colors.muted}
              maxLength={300}
              multiline
              editable={!busy}
              style={[styles.reason, reasonError ? { borderColor: colors.red } : null]}
              accessibilityLabel="Votre explication"
              accessibilityHint={reasonError ?? undefined}
            />
            {reasonError ? <Text style={styles.reasonError}>{reasonError}</Text> : null}
            <Text style={styles.sheetNote}>{frTypo(`Votre contestation est transmise à ${dispute.giver}, qui reste seule à confirmer ses encaissements.`)}</Text>
            <View style={{ gap: space.sm }}>
              <BigButton title="Envoyer la contestation" icon="send-outline" height={control.lg} loading={busy} onPress={() => void sendDispute()} />
              <BigButton title="Annuler" variant="ghost" height={control.sm} disabled={busy} onPress={() => setDispute(null)} />
            </View>
          </>
        )}
      </BottomSheet>
    </>
  );
}

/** Une organisation partenaire : à régler (ses moyens), signalé payé, à recevoir, blocage, courses. */
function OrganizationBlock({
  org, currency, tz, now, onCopyReference, onPay, onDispute,
}: {
  org: CreditorView;
  currency: string;
  tz?: string;
  now: number;
  onCopyReference: (ref: string | null) => void;
  onPay: (method: "link" | ManualMethod) => void;
  onDispute: (item: DriverNetworkSettlementItem, label: string, prompt: string) => void;
}) {
  const price = (c: number) => formatPrice(c, currency);
  const pay = org.pay;
  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.blockTitle} accessibilityRole="header" numberOfLines={2}>{org.name}</Text>
          <Text style={styles.blockSub}>Organisation partenaire</Text>
        </View>
        {org.phone ? (
          <Pressable
            onPress={() => void Linking.openURL(`tel:${org.phone}`)}
            style={({ pressed }) => [styles.call, pressed && { backgroundColor: colors.surface3 }]}
            accessibilityRole="button"
            accessibilityLabel={`Appeler ${org.name}, ${formatPhone(org.phone)}`}
          >
            <Ionicons name="call-outline" size={22} color={colors.fg} />
          </Pressable>
        ) : null}
      </View>

      {org.blocked && (
        <View style={styles.alert} accessibilityRole="alert">
          <Ionicons name="lock-closed-outline" size={20} color={colors.red} />
          <Text style={styles.alertText}>{org.blocked}</Text>
        </View>
      )}

      {pay ? (
        <View style={styles.pay}>
          <Text style={styles.payLabel} numberOfLines={1}>À régler à {org.name}</Text>
          <Text style={[styles.payAmount, pay.urgent && { color: colors.red }]} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={`${price(pay.amountCents)} à régler`}>
            {price(pay.amountCents)}
          </Text>
          <View style={styles.refRow}>
            <Text style={styles.payMeta}>{plural(pay.count, "course", "courses")} · référence</Text>
            <Pressable
              onPress={() => onCopyReference(pay.reference)}
              style={({ pressed }) => [styles.refChip, pressed && { backgroundColor: colors.surface3 }]}
              accessibilityRole="button"
              accessibilityLabel={`Copier la référence ${pay.reference}`}
            >
              <Text style={styles.refChipText} selectable>{pay.reference}</Text>
              <Ionicons name="copy-outline" size={18} color={colors.muted} />
            </Pressable>
          </View>
          <View style={styles.dueRow}>
            <Ionicons name={pay.urgent ? "alert-circle-outline" : "time-outline"} size={20} color={pay.urgent ? colors.red : colors.muted} />
            <Text style={[styles.dueText, pay.urgent && { color: colors.red }]}>{pay.dueLine}</Text>
          </View>
          <View style={styles.actions}>
            {pay.link ? (
              <BigButton
                title={`Payer ${price(pay.amountCents)}`}
                icon="open-outline"
                height={control.lg}
                onPress={() => onPay("link")}
                accessibilityHint={pay.linkDomain ? `Ouvre ${pay.linkDomain}` : undefined}
              />
            ) : null}
            {pay.link && pay.linkDomain ? <Text style={styles.domain}>Lien de paiement de {org.name} : {pay.linkDomain}</Text> : null}
            {pay.manual.map((m, i) => (
              <BigButton
                key={m}
                title={METHOD_BUTTON[m]}
                icon={SETTLEMENT_METHOD_META[m].ionicon as keyof typeof Ionicons.glyphMap}
                variant={!pay.link && i === 0 ? "primary" : "secondary"}
                height={!pay.link && i === 0 ? control.lg : control.md}
                onPress={() => onPay(m)}
              />
            ))}
            {!pay.link && pay.manual.length === 0 ? (
              <Text style={styles.cardText}>{frTypo(`Aucun moyen de paiement renseigné : appelez ${org.name}.`)}</Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {org.declaredCents > 0 && !pay ? (
        <View style={styles.cardRow}>
          <Ionicons name="time-outline" size={20} color={colors.blue} style={styles.lead} />
          <Text style={[styles.cardText, { flex: 1 }]}>{frTypo(`Paiement signalé : ${price(org.declaredCents)} en attente de confirmation par ${org.name}.`)}</Text>
        </View>
      ) : null}

      {org.payout ? (
        <View style={styles.cardRow}>
          <Ionicons name="arrow-down-circle-outline" size={20} color={org.payout.cents > 0 ? colors.green : colors.amber} style={styles.lead} />
          <Text style={[styles.cardText, { flex: 1 }]}>{org.payout.text}</Text>
        </View>
      ) : null}

      {org.open.length + org.closed.length > 0 && <Label style={styles.section}>Courses</Label>}
      {[...org.open, ...org.closed].map((item, i) => (
        <ItemRow key={item.id} item={item} giver={org.name} tz={tz} now={now} first={i === 0} onDispute={onDispute} />
      ))}
    </View>
  );
}

function ItemRow({
  item, giver, tz, now, first, onDispute,
}: {
  item: DriverNetworkSettlementItem;
  giver: string;
  tz?: string;
  now: number;
  first: boolean;
  onDispute: (item: DriverNetworkSettlementItem, label: string, prompt: string) => void;
}) {
  const v = partnerItemView(item, giver, tz, now);
  const amountColor = v.amountTone === "red" ? colors.red : v.amountTone === "muted" ? colors.muted : colors.fg;
  return (
    <View style={[styles.row, !first && styles.rowBorder]}>
      <View
        style={styles.rowHead}
        accessible
        accessibilityLabel={`${v.title}, ${v.kind} ${v.amount}, ${v.status}${v.detail ? `, ${v.detail}` : ""}`}
      >
        <Ionicons name={v.owes ? "arrow-up-outline" : "arrow-down-outline"} size={20} color={colors.muted} style={styles.lead} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {v.title}
            <Text style={styles.rowKind}>{` · ${v.kind}`}</Text>
          </Text>
          <Text style={styles.rowRoute} numberOfLines={1}>{v.route}</Text>
          <Text style={styles.rowMeta} numberOfLines={1}>{v.meta}</Text>
        </View>
        <Text style={[styles.rowAmount, { color: amountColor }]}>{v.amount}</Text>
      </View>
      <View style={styles.rowFoot}>
        <Pill label={v.status} color={TONE[v.statusTone]} />
        {v.detail ? <Text style={[styles.rowDetail, v.statusTone === "red" && { color: colors.red }]} numberOfLines={2}>{v.detail}</Text> : null}
      </View>
      {v.notReceived ? (
        <View style={styles.alert}>
          <Ionicons name="alert-circle-outline" size={20} color={colors.red} />
          <Text style={styles.alertText}>{v.notReceived}</Text>
        </View>
      ) : null}
      {v.disputed ? <Text style={styles.disputed}>{v.disputed}</Text> : null}
      {v.dispute ? (
        <BigButton
          title={v.dispute.label}
          variant="secondary"
          height={control.sm}
          onPress={() => onDispute(item, v.dispute!.label, v.dispute!.prompt)}
          style={styles.disputeBtn}
        />
      ) : null}
    </View>
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

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  tile: {
    flexBasis: "47%", flexGrow: 1, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.lg,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 2,
  },
  tileLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  tileValue: { fontSize: type.title3, fontWeight: weight.bold, marginTop: 2, ...mono },
  tileHint: { color: colors.muted, fontSize: type.footnote },
  card: { padding: space.lg, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  cardRow: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  cardText: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  lead: { marginTop: 1 },
  empty: { alignItems: "center", gap: space.sm, paddingVertical: 48, paddingHorizontal: space.xl },
  emptyTitle: { color: colors.fg, fontSize: type.title3, fontWeight: weight.semibold, marginTop: space.xs },
  emptyText: { color: colors.muted, fontSize: type.body, textAlign: "center", lineHeight: 21 },
  block: { borderRadius: radius.lg, padding: space.lg, gap: space.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  blockHead: { flexDirection: "row", alignItems: "center", gap: space.md },
  blockTitle: { color: colors.fg, fontSize: type.headline, fontWeight: weight.bold },
  blockSub: { color: colors.muted, fontSize: type.footnote, marginTop: 2 },
  call: {
    width: control.md, height: control.md, borderRadius: radius.full, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong,
    alignItems: "center", justifyContent: "center",
  },
  alert: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface2 },
  alertText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
  pay: { gap: space.md },
  payLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  payAmount: { color: colors.fg, fontSize: type.display, fontWeight: weight.bold, letterSpacing: -0.5, marginTop: -space.xs, ...mono },
  payMeta: { color: colors.muted, fontSize: type.body, ...mono },
  refRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm },
  refChip: {
    flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.sm,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong,
  },
  refChipText: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold, letterSpacing: 0.5, ...mono },
  dueRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  dueText: { flex: 1, color: colors.muted, fontSize: type.body, lineHeight: 21, ...mono },
  actions: { gap: space.sm, marginTop: space.xs },
  domain: { color: colors.muted, fontSize: type.footnote, lineHeight: 18, textAlign: "center" },
  section: { marginTop: space.xs },
  row: { paddingVertical: space.md, gap: space.sm },
  rowBorder: { borderTopWidth: 1, borderColor: colors.line },
  rowHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  rowTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold, ...mono },
  rowKind: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.regular },
  rowRoute: { color: colors.fg, fontSize: type.body },
  rowMeta: { color: colors.muted, fontSize: type.footnote, ...mono },
  rowAmount: { fontSize: type.headline, fontWeight: weight.bold, ...mono },
  rowFoot: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, paddingLeft: 32 },
  rowDetail: { flex: 1, minWidth: 140, color: colors.muted, fontSize: type.footnote, ...mono },
  disputed: { color: colors.muted, fontSize: type.footnote, lineHeight: 18, paddingLeft: 32 },
  disputeBtn: { alignSelf: "flex-start", marginLeft: 32, minWidth: 160 },
  footnote: { color: colors.muted, fontSize: type.footnote, marginTop: space.xs, lineHeight: 18 },
  sheetTitle: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold },
  sheetSub: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  sheetNote: { color: colors.muted, fontSize: type.footnote, lineHeight: 18 },
  reason: {
    minHeight: 96, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, backgroundColor: colors.surface2,
    borderWidth: 1, borderColor: colors.line, color: colors.fg, fontSize: type.callout, textAlignVertical: "top",
  },
  reasonError: { color: colors.red, fontSize: type.footnote, fontWeight: weight.medium },
});
