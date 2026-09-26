// Justificatifs du chauffeur (écran « Mes documents » et écran d'attente du candidat) : statut, échéance,
// motif de refus ; dépôt par photo (driver_submit_document — autorisé aussi au candidat en attente).
// Sobre : cartes neutres, pictogrammes gris ; seule l'étiquette de statut porte la couleur.
import { Ionicons } from "@expo/vector-icons";
import {
  DOCUMENT_STATE_META, DOCUMENT_TYPE_LABELS, documentStateLabel, formatDate,
  type DocumentDisplayState, type DocumentType, type DriverDocumentItem, type DriverDocuments,
} from "@rydar/shared";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AccessibilityInfo, Image, Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { frTypo } from "@/components/centrale";
import { BigButton, BottomSheet, hapticResult, Pill } from "@/components/ui";
import { api, STORAGE_UNAVAILABLE, type ApiError } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { assetBytes, extensionFor, formatIsoDay, maskDate, parseFrDate } from "@/lib/files";
import { colors, control, mono, overlay, radius, space, toneColor, type, weight } from "@/theme";

/** Espace insécable (typographie française : avant « : ; ! ? », entre un nombre et son unité). */
const NB = " ";

const REQUIRED: DocumentType[] = ["vtc_card", "driving_license", "identity", "insurance", "vehicle_registration"];

const TYPE_ICON: Record<DocumentType, keyof typeof Ionicons.glyphMap> = {
  vtc_card: "id-card-outline",
  driving_license: "car-outline",
  identity: "person-outline",
  insurance: "shield-checkmark-outline",
  vehicle_registration: "document-text-outline",
  medical: "medkit-outline",
  other: "document-outline",
};

export type DocEntry = { key: string; type: DocumentType; doc: DriverDocumentItem | null; state: DocumentDisplayState };

/** États à traiter par le chauffeur (manquant, refusé, expiré, bientôt échu). */
export const isTodo = (s: DocumentDisplayState) => s === "missing" || s === "rejected" || s === "expired" || s === "expiring";

/** « 3 documents », « 1 manquant » : nombre et mot insécables, pluriel. */
const count = (n: number, word: string) => `${n}${NB}${word}${n > 1 ? "s" : ""}`;

/** Libellé du statut, « Expire dans 12 j » insécable. */
const stateLabel = (state: DocumentDisplayState, daysLeft?: number | null) => documentStateLabel(state, daysLeft).replace(/(\d) j$/, `$1${NB}j`);

function announce(message: string) {
  try {
    if (typeof AccessibilityInfo.announceForAccessibility === "function") AccessibilityInfo.announceForAccessibility(message);
  } catch {
    /* pas de lecteur d'écran sur cette plateforme */
  }
}

/**
 * Une ligne par document, + « Manquant » pour chaque type exigé absent (ordre : à traiter d'abord,
 * puis en validation, puis valides ; types exigés avant les autres).
 */
export function buildDocEntries(data: DriverDocuments | null): DocEntry[] {
  if (!data) return [];
  const list: DocEntry[] = data.documents.map((d) => ({ key: d.id, type: d.type, doc: d, state: d.status }));
  // Type exigé sans document valable : « Manquant », sauf s'il est déjà affiché (expiré, refusé) avec son bouton
  for (const t of data.missing_types) {
    if (!list.some((e) => e.type === t)) list.push({ key: `missing-${t}`, type: t, doc: null, state: "missing" });
  }
  const rank = (t: DocumentType) => (REQUIRED.indexOf(t) === -1 ? 99 : REQUIRED.indexOf(t));
  const stateRank: Record<DocumentDisplayState, number> = { missing: 0, rejected: 1, expired: 2, expiring: 3, pending: 4, valid: 5 };
  const bucket = (s: DocumentDisplayState) => (s === "pending" ? 1 : s === "valid" ? 2 : 0);
  return list.sort((a, b) => bucket(a.state) - bucket(b.state) || rank(a.type) - rank(b.type) || stateRank[a.state] - stateRank[b.state]);
}

/** Lecture de driver_documents : au focus, sur signal « documents » (temps réel / notification) et à la demande. */
export function useDriverDocuments(enabled = true) {
  const [data, setData] = useState<DriverDocuments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setData(await api.documents());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [enabled]);
  useFocusEffect(useCallback(() => void load(), [load]));
  useAppEvent("documents", () => void load());
  return { data, error, load };
}

/** Synthèse : « 3 documents à mettre à jour » / « Dossier complet ». */
export function DocumentsSummary({ data, entries }: { data: DriverDocuments; entries: DocEntry[] }) {
  const todo = entries.filter((e) => isTodo(e.state)).length;
  const s = data.summary;
  const valid = s.valid + s.expiring;
  const title = todo > 0 ? `${count(todo, "document")} à mettre à jour` : "Dossier complet";
  const sub =
    [
      valid > 0 ? count(valid, "valide") : null,
      s.pending > 0 ? `${s.pending}${NB}en validation` : null,
      data.missing_types.length > 0 ? count(data.missing_types.length, "manquant") : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Ajoutez vos justificatifs";
  return (
    <View style={styles.summary} accessible accessibilityLabel={`${title}. ${sub}`}>
      <Ionicons name={todo > 0 ? "alert-circle-outline" : "checkmark-circle-outline"} size={20} color={colors.muted} style={styles.leadIcon} />
      <View style={styles.flexText}>
        <Text style={styles.summaryTitle}>{title}</Text>
        <Text style={[styles.summarySub, mono]}>{sub}</Text>
      </View>
    </View>
  );
}

export function DocCard({ entry, tz, onUpdate }: { entry: DocEntry; tz?: string; onUpdate: () => void }) {
  const { doc, state, type: docType } = entry;
  const meta = DOCUMENT_STATE_META[state];
  const color = state === "missing" ? colors.muted : toneColor(meta.tone);
  const label = doc?.label ?? DOCUMENT_TYPE_LABELS[docType] ?? "Document";
  const status = stateLabel(state, doc?.days_left);
  const urgent = isTodo(state);
  const details = [
    doc?.number ? `N°${NB}${doc.number}` : null,
    doc ? (doc.expires_at ? `Échéance ${formatIsoDay(doc.expires_at)}` : "Sans échéance") : "Obligatoire pour rouler",
  ].filter(Boolean).join(" · ");
  const action = state === "missing" ? "Ajouter" : state === "pending" ? "Remplacer" : "Mettre à jour";
  return (
    <View style={styles.card}>
      <View style={styles.cardHead} accessible accessibilityLabel={`${label}. ${details}`}>
        <Ionicons name={TYPE_ICON[docType] ?? "document-outline"} size={20} color={colors.muted} style={styles.leadIcon} />
        <View style={styles.flexText}>
          <Text style={styles.cardTitle} numberOfLines={2}>{label}</Text>
          <Text style={[styles.cardSub, mono]} numberOfLines={1}>{details}</Text>
        </View>
      </View>
      <View style={styles.stateRow}>
        <Pill label={status} color={color} />
        {!urgent && (
          <Pressable
            onPress={onUpdate}
            style={({ pressed }) => [styles.smallAction, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${state === "pending" ? "Remplacer l'envoi" : "Mettre à jour"}${NB}: ${label}`}
          >
            <Ionicons name="camera-outline" size={18} color={colors.fg} />
            <Text style={styles.smallActionText}>{action}</Text>
          </Pressable>
        )}
      </View>
      {state === "rejected" && doc?.review_note ? (
        <View style={styles.reason} accessible accessibilityLabel={`Motif du refus${NB}: ${doc.review_note}`}>
          <Ionicons name="chatbox-ellipses-outline" size={20} color={colors.muted} style={styles.leadIcon} />
          <Text style={styles.reasonText}>
            <Text style={styles.reasonLabel}>Motif{NB}: </Text>
            {frTypo(doc.review_note)}
          </Text>
        </View>
      ) : null}
      {state === "pending" && doc ? (
        <Text style={styles.pendingText}>Envoyé le {formatDate(doc.created_at, tz)} · en cours de vérification par la centrale</Text>
      ) : null}
      {urgent && (
        <BigButton
          title={action}
          icon={state === "missing" ? "add-outline" : "camera-outline"}
          variant="secondary"
          height={control.md}
          onPress={onUpdate}
          accessibilityLabel={`${action}${NB}: ${label}`}
        />
      )}
    </View>
  );
}

type Picked = { asset: ImagePicker.ImagePickerAsset; mime: string };

/** Champ de la feuille : libellé au-dessus, cadre de 56 px, bordure lime au focus. */
function SheetField({ label, style, onFocus, onBlur, ...input }: Omit<TextInputProps, "style"> & { label: string; style?: TextInputProps["style"] }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel} accessible={false} importantForAccessibility="no" accessibilityElementsHidden>
        {label}
      </Text>
      <TextInput
        placeholderTextColor={colors.muted}
        selectionColor={colors.brand}
        cursorColor={colors.brand}
        keyboardAppearance="dark"
        accessibilityLabel={label}
        maxFontSizeMultiplier={1.4}
        {...input}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={[styles.input, { borderColor: focused ? colors.brand : colors.lineStrong }, style]}
      />
    </View>
  );
}

/** Feuille « Mettre à jour » : photo (appareil ou galerie ; fichier sur le web) + échéance + numéro → envoi. */
export function UploadSheet({
  entry, orgId, driverId, onClose, onDone,
}: { entry: DocEntry | null; orgId?: string; driverId?: string; onClose: () => void; onDone: (message: string) => void }) {
  // Document affiché : reste celui de la dernière ouverture pendant l'animation de fermeture
  const [shown, setShown] = useState<DocEntry | null>(entry);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [expiry, setExpiry] = useState("");
  const [number, setNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!entry) return;
    setShown(entry);
    setPicked(null);
    setError(null);
    setNumber(entry.doc?.number ?? "");
    setExpiry("");
  }, [entry]);

  useEffect(() => {
    if (error) announce(error);
  }, [error]);

  const current = entry ?? shown;
  const label = current ? (current.doc?.label ?? DOCUMENT_TYPE_LABELS[current.type] ?? "Document") : "";

  async function pick(source: "camera" | "library") {
    setError(null);
    try {
      if (source === "camera") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          setError("Autorisez l'appareil photo dans les réglages pour photographier le document.");
          return;
        }
      }
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.6, base64: Platform.OS !== "web", exif: false };
      const res = source === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      const asset = res.canceled ? null : res.assets?.[0];
      if (asset) setPicked({ asset, mime: asset.mimeType ?? "image/jpeg" });
    } catch {
      setError("Impossible d'ouvrir les photos.");
    }
  }

  async function submit() {
    if (!current) return;
    if (!orgId || !driverId) return setError("Connexion impossible. Réessayez dans un instant.");
    if (!picked) return setError("Ajoutez une photo du document.");
    let expiresAt: string | null = null;
    if (expiry.trim()) {
      expiresAt = parseFrDate(expiry);
      if (!expiresAt) return setError("Date d'expiration invalide (JJ/MM/AAAA).");
      if (expiresAt < new Date().toISOString().slice(0, 10)) return setError(`Ce document est déjà expiré${NB}: envoyez le nouveau.`);
    }
    setBusy(true);
    setError(null);
    try {
      const path = `${orgId}/${driverId}/${current.type}-${Date.now()}.${extensionFor(picked.mime)}`;
      const bytes = await assetBytes(picked.asset);
      if (bytes.byteLength > 10 * 1024 * 1024) throw new Error(`Photo trop lourde (10${NB}Mo maximum).`);
      await api.uploadDocument(path, bytes, picked.mime);
      const res = await api.submitDocument({ type: current.type, filePath: path, expiresAt, number: number.trim() || null });
      if (!res.ok) {
        hapticResult(false);
        setError(res.message ?? "Envoi refusé.");
        return;
      }
      hapticResult(true);
      onDone(res.message ?? "Document envoyé à la centrale pour validation.");
    } catch (e) {
      hapticResult(false);
      const err = e as ApiError;
      setError(err.code === "STORAGE_UNAVAILABLE" ? `${STORAGE_UNAVAILABLE} Remettez le document à votre centrale en attendant.` : err.message);
    } finally {
      setBusy(false);
    }
  }

  const web = Platform.OS === "web";
  return (
    <BottomSheet visible={!!entry} onClose={onClose} dismissable={!busy} keyboard>
      {current && (
        <>
          <View style={styles.sheetHead}>
            <View style={styles.flexText}>
              <Text style={styles.sheetTitle} accessibilityRole="header">{label}</Text>
              <Text style={styles.sheetSub}>Photo nette, document entier, sans reflet.</Text>
            </View>
            <Pressable
              onPress={onClose}
              disabled={busy}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Fermer"
              accessibilityState={{ disabled: busy }}
            >
              <Ionicons name="close" size={22} color={colors.fg} />
            </Pressable>
          </View>

          {picked ? (
            <View style={styles.preview}>
              <Image source={{ uri: picked.asset.uri }} style={styles.previewImg} resizeMode="cover" accessibilityLabel="Aperçu du document" />
              <Pressable
                onPress={() => setPicked(null)}
                disabled={busy}
                style={({ pressed }) => [styles.previewReset, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Changer de photo"
                accessibilityState={{ disabled: busy }}
              >
                <Ionicons name="refresh-outline" size={18} color={colors.fg} />
                <Text style={styles.previewResetText}>Changer</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.pickRow}>
              {!web && (
                <Pressable
                  onPress={() => void pick("camera")}
                  style={({ pressed }) => [styles.pick, styles.pickMain, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityLabel="Prendre une photo"
                >
                  <Ionicons name="camera-outline" size={24} color={colors.brandFg} />
                  <Text style={[styles.pickText, { color: colors.brandFg }]}>Prendre une photo</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => void pick("library")}
                style={({ pressed }) => [styles.pick, web && styles.pickMain, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={web ? "Choisir un fichier" : "Choisir dans la galerie"}
              >
                <Ionicons name={web ? "cloud-upload-outline" : "images-outline"} size={24} color={web ? colors.brandFg : colors.fg} />
                <Text style={[styles.pickText, web && { color: colors.brandFg }]}>{web ? "Choisir un fichier" : "Galerie"}</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.fields}>
            <View style={{ flex: 1.1 }}>
              <SheetField
                label="Date d'expiration"
                value={expiry}
                onChangeText={(t) => setExpiry(maskDate(t))}
                placeholder="JJ/MM/AAAA"
                keyboardType="number-pad"
                maxLength={10}
                editable={!busy}
                style={mono}
              />
            </View>
            <View style={{ flex: 1 }}>
              <SheetField
                label="Numéro (facultatif)"
                value={number}
                onChangeText={setNumber}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={60}
                editable={!busy}
                accessibilityLabel="Numéro du document, facultatif"
              />
            </View>
          </View>

          {error && (
            <View style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Ionicons name="alert-circle-outline" size={20} color={colors.red} style={styles.leadIcon} />
              <Text style={styles.errorText}>{frTypo(error)}</Text>
            </View>
          )}

          <BigButton title="Envoyer à la centrale" height={control.md} onPress={() => void submit()} loading={busy} disabled={!picked} />
        </>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  flexText: { flex: 1, gap: 2 },
  leadIcon: { marginTop: 1 },
  summary: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg,
    borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
  },
  summaryTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  summarySub: { color: colors.muted, fontSize: type.subhead },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  cardTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  cardSub: { color: colors.muted, fontSize: type.subhead },
  stateRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm + 2 },
  smallAction: {
    flexDirection: "row", alignItems: "center", gap: space.sm - 2, height: control.sm, paddingHorizontal: space.lg,
    borderRadius: radius.md, backgroundColor: colors.surface3, borderWidth: 1, borderColor: colors.lineStrong,
  },
  smallActionText: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.semibold },
  reason: { flexDirection: "row", gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surface2 },
  reasonLabel: { fontWeight: weight.semibold },
  reasonText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
  pendingText: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  sheetTitle: { color: colors.fg, fontSize: type.title3, fontWeight: weight.bold, letterSpacing: -0.2 },
  sheetSub: { color: colors.muted, fontSize: type.body, marginTop: 2 },
  close: { width: control.sm, height: control.sm, borderRadius: radius.full, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  pickRow: { flexDirection: "row", gap: space.sm + 2 },
  pick: {
    flex: 1, height: 96, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", gap: space.sm,
    backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong,
  },
  pickMain: { backgroundColor: colors.brand, borderColor: colors.brand },
  pickText: { color: colors.fg, fontSize: type.body, fontWeight: weight.semibold },
  preview: { height: 170, borderRadius: radius.lg, overflow: "hidden", backgroundColor: colors.surface2 },
  previewImg: { width: "100%", height: "100%" },
  previewReset: {
    ...overlay, position: "absolute", right: space.sm + 2, bottom: space.sm + 2, flexDirection: "row", alignItems: "center", gap: space.sm - 2,
    paddingHorizontal: space.md + 2, height: control.sm, borderRadius: radius.md,
  },
  previewResetText: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.semibold },
  fields: { flexDirection: "row", gap: space.sm + 2 },
  field: { gap: space.sm },
  fieldLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  input: {
    height: control.md, borderRadius: radius.md, paddingHorizontal: space.md + 2, backgroundColor: colors.bg, borderWidth: 1,
    color: colors.fg, fontSize: type.callout, fontWeight: weight.medium,
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : null),
  },
  error: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 14,
    borderRadius: radius.md, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line,
  },
  errorText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
});
