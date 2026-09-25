// Documents du chauffeur : statut, échéance, motif de refus ; mise à jour par photo (driver_submit_document).
import { Ionicons } from "@expo/vector-icons";
import {
  DOCUMENT_STATE_META, DOCUMENT_TYPE_LABELS, documentStateLabel, formatDate,
  type DocumentDisplayState, type DocumentType, type DriverDocumentItem, type DriverDocuments,
} from "@rydar/shared";
import * as ImagePicker from "expo-image-picker";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, Animated, Image, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { BigButton, hapticResult, Screen, ScreenHeader, Sheet, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api, STORAGE_UNAVAILABLE, type ApiError } from "@/lib/api";
import { useAppEvent } from "@/lib/events";
import { assetBytes, extensionFor, formatIsoDay, maskDate, parseFrDate } from "@/lib/files";
import { colors, toneColor } from "@/theme";

const REQUIRED: DocumentType[] = ["vtc_card", "driving_license", "identity", "insurance", "vehicle_registration"];

const TYPE_ICON: Record<DocumentType, keyof typeof Ionicons.glyphMap> = {
  vtc_card: "id-card",
  driving_license: "car",
  identity: "person",
  insurance: "shield-checkmark",
  vehicle_registration: "document-text",
  medical: "medkit",
  other: "document",
};

type Entry = { key: string; type: DocumentType; doc: DriverDocumentItem | null; state: DocumentDisplayState };

export default function Documents() {
  const { home } = useDriver();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 64);
  const [data, setData] = useState<DriverDocuments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Entry | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.documents());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));
  // Validation, refus ou échéance reçus en temps réel / par notification
  useAppEvent("documents", () => void load());

  // Une ligne par document, + « Manquant » pour chaque type exigé absent (ordre : types exigés d'abord)
  const entries = useMemo<Entry[]>(() => {
    if (!data) return [];
    const list: Entry[] = data.documents.map((d) => ({ key: d.id, type: d.type, doc: d, state: d.status }));
    // Type exigé sans document valable : « Manquant », sauf s'il est déjà affiché (expiré, refusé) avec son bouton
    for (const t of data.missing_types) {
      if (!list.some((e) => e.type === t)) list.push({ key: `missing-${t}`, type: t, doc: null, state: "missing" });
    }
    const rank = (t: DocumentType) => (REQUIRED.indexOf(t) === -1 ? 99 : REQUIRED.indexOf(t));
    const stateRank: Record<DocumentDisplayState, number> = { missing: 0, rejected: 1, expired: 2, expiring: 3, pending: 4, valid: 5 };
    // À traiter d'abord (manquant, refusé, expiré, bientôt échu), puis en validation, puis valides
    const bucket = (s: DocumentDisplayState) => (s === "pending" ? 1 : s === "valid" ? 2 : 0);
    return list.sort((a, b) => bucket(a.state) - bucket(b.state) || rank(a.type) - rank(b.type) || stateRank[a.state] - stateRank[b.state]);
  }, [data]);

  const todo = entries.filter((e) => ["missing", "rejected", "expired", "expiring"].includes(e.state)).length;
  const s = data?.summary;

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ScreenHeader title="Mes documents" />
        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
          refreshControl={
            <RefreshControl
              tintColor={colors.brand}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
        >
          {!data ? (
            <View style={{ paddingVertical: 80, alignItems: "center" }}>
              {error ? <Text style={styles.errorText}>{error}</Text> : <ActivityIndicator color={colors.brand} />}
            </View>
          ) : (
            <>
              <View style={[styles.summary, { borderColor: todo > 0 ? "rgba(245,181,68,0.35)" : "rgba(79,213,143,0.3)" }]}>
                <View style={[styles.summaryIcon, { backgroundColor: todo > 0 ? "rgba(245,181,68,0.14)" : "rgba(79,213,143,0.14)" }]}>
                  <Ionicons name={todo > 0 ? "alert-circle" : "shield-checkmark"} size={24} color={todo > 0 ? colors.amber : colors.green} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.summaryTitle}>{todo > 0 ? `${todo} document${todo > 1 ? "s" : ""} à mettre à jour` : "Dossier complet"}</Text>
                  <Text style={styles.summarySub}>
                    {[
                      s && s.valid + s.expiring > 0 ? `${s.valid + s.expiring} valide${s.valid + s.expiring > 1 ? "s" : ""}` : null,
                      s && s.pending > 0 ? `${s.pending} en validation` : null,
                      data.missing_types.length > 0 ? `${data.missing_types.length} manquant${data.missing_types.length > 1 ? "s" : ""}` : null,
                    ].filter(Boolean).join(" · ") || "Ajoutez vos justificatifs"}
                  </Text>
                </View>
              </View>

              {entries.map((e) => (
                <DocCard key={e.key} entry={e} tz={home?.organization.timezone} onUpdate={() => setEditing(e)} />
              ))}
              <Text style={styles.footnote}>Les documents envoyés sont vérifiés par votre centrale avant d&apos;être validés.</Text>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
      {flash.node}
      <UploadSheet
        entry={editing}
        orgId={home?.organization.id}
        driverId={home?.driver.id}
        onClose={() => setEditing(null)}
        onDone={(msg) => {
          setEditing(null);
          flash.show(msg);
          void load();
        }}
      />
    </Screen>
  );
}

function DocCard({ entry, tz, onUpdate }: { entry: Entry; tz?: string; onUpdate: () => void }) {
  const { doc, state, type } = entry;
  const meta = DOCUMENT_STATE_META[state];
  const color = state === "missing" ? colors.muted : toneColor(meta.tone);
  const label = doc?.label ?? DOCUMENT_TYPE_LABELS[type] ?? "Document";
  const urgent = state === "missing" || state === "rejected" || state === "expired" || state === "expiring";
  const details = [
    doc?.number ? `N° ${doc.number}` : null,
    doc ? (doc.expires_at ? `Échéance ${formatIsoDay(doc.expires_at)}` : "Sans échéance") : "Obligatoire pour rouler",
  ].filter(Boolean).join(" · ");
  return (
    <View style={[styles.card, urgent && { borderColor: `${color}55` }]}>
      <View style={styles.cardHead}>
        <View style={[styles.cardIcon, { backgroundColor: `${color}1C` }]}>
          <Ionicons name={TYPE_ICON[type] ?? "document"} size={20} color={color} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>{label}</Text>
          <Text style={styles.cardSub} numberOfLines={1}>{details}</Text>
        </View>
      </View>
      <View style={styles.stateRow}>
        <View style={[styles.state, { backgroundColor: `${color}1F` }]}>
          <View style={[styles.stateDot, { backgroundColor: color }]} />
          <Text style={[styles.stateText, { color }]}>{documentStateLabel(state, doc?.days_left)}</Text>
        </View>
        {!urgent && (
          <Pressable onPress={onUpdate} style={({ pressed }) => [styles.smallAction, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={`${state === "pending" ? "Remplacer l'envoi" : "Mettre à jour"} : ${label}`}>
            <Ionicons name="camera-outline" size={16} color={colors.fg} />
            <Text style={styles.smallActionText}>{state === "pending" ? "Remplacer" : "Mettre à jour"}</Text>
          </Pressable>
        )}
      </View>
      {state === "rejected" && doc?.review_note ? (
        <View style={styles.reason}>
          <Ionicons name="chatbox-ellipses-outline" size={16} color={colors.red} />
          <Text style={styles.reasonText}>
            <Text style={{ fontWeight: "800" }}>Motif : </Text>
            {doc.review_note}
          </Text>
        </View>
      ) : null}
      {state === "pending" && doc ? (
        <Text style={styles.pendingText}>Envoyé le {formatDate(doc.created_at, tz)} · en cours de vérification par la centrale</Text>
      ) : null}
      {urgent && (
        <BigButton
          title={state === "missing" ? "Ajouter" : "Mettre à jour"}
          icon={state === "missing" ? "add-circle-outline" : "camera-outline"}
          height={50}
          onPress={onUpdate}
        />
      )}
    </View>
  );
}

type Picked = { asset: ImagePicker.ImagePickerAsset; mime: string };

/** Feuille « Mettre à jour » : photo (appareil ou galerie ; fichier sur le web) + échéance + numéro → envoi. */
function UploadSheet({
  entry, orgId, driverId, onClose, onDone,
}: { entry: Entry | null; orgId?: string; driverId?: string; onClose: () => void; onDone: (message: string) => void }) {
  const anim = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState<Entry | null>(entry);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [expiry, setExpiry] = useState("");
  const [number, setNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (entry) {
      setShown(entry);
      setPicked(null);
      setError(null);
      setNumber(entry.doc?.number ?? "");
      setExpiry("");
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 9, tension: 70 }).start();
    } else Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => setShown(null));
  }, [entry, anim]);

  if (!shown) return null;
  const label = shown.doc?.label ?? DOCUMENT_TYPE_LABELS[shown.type] ?? "Document";

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
    if (!shown || !orgId || !driverId) return;
    if (!picked) return setError("Ajoutez une photo du document.");
    let expiresAt: string | null = null;
    if (expiry.trim()) {
      expiresAt = parseFrDate(expiry);
      if (!expiresAt) return setError("Date d'expiration invalide (JJ/MM/AAAA).");
      if (expiresAt < new Date().toISOString().slice(0, 10)) return setError("Ce document est déjà expiré : envoyez le nouveau.");
    }
    setBusy(true);
    setError(null);
    try {
      const path = `${orgId}/${driverId}/${shown.type}-${Date.now()}.${extensionFor(picked.mime)}`;
      const bytes = await assetBytes(picked.asset);
      if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("Photo trop lourde (10 Mo maximum).");
      await api.uploadDocument(path, bytes, picked.mime);
      const res = await api.submitDocument({ type: shown.type, filePath: path, expiresAt, number: number.trim() || null });
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
    <View style={[StyleSheet.absoluteFill, { zIndex: 40 }]} pointerEvents="box-none">
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: anim }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={busy ? undefined : onClose} accessibilityLabel="Fermer" />
      </Animated.View>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap} pointerEvents="box-none">
        <Animated.View style={{ transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [640, 0] }) }] }}>
          <Sheet>
            <SafeAreaView edges={["bottom"]} style={{ gap: 14, paddingBottom: 14 }}>
              <View style={styles.sheetHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetTitle}>{label}</Text>
                  <Text style={styles.sheetSub}>Photo nette, document entier, sans reflet.</Text>
                </View>
                <Pressable onPress={onClose} disabled={busy} style={styles.close} accessibilityLabel="Fermer" hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.fg} />
                </Pressable>
              </View>

              {picked ? (
                <View style={styles.preview}>
                  <Image source={{ uri: picked.asset.uri }} style={styles.previewImg} resizeMode="cover" accessibilityLabel="Aperçu du document" />
                  <Pressable onPress={() => setPicked(null)} style={styles.previewReset} accessibilityLabel="Changer de photo">
                    <Ionicons name="refresh" size={16} color={colors.fg} />
                    <Text style={styles.previewResetText}>Changer</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.pickRow}>
                  {!web && (
                    <Pressable onPress={() => void pick("camera")} style={[styles.pick, styles.pickMain]} accessibilityRole="button">
                      <Ionicons name="camera" size={26} color={colors.brandFg} />
                      <Text style={[styles.pickText, { color: colors.brandFg }]}>Prendre une photo</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => void pick("library")} style={[styles.pick, web && styles.pickMain]} accessibilityRole="button">
                    <Ionicons name={web ? "cloud-upload" : "images"} size={26} color={web ? colors.brandFg : colors.fg} />
                    <Text style={[styles.pickText, web && { color: colors.brandFg }]}>{web ? "Choisir un fichier" : "Galerie"}</Text>
                  </Pressable>
                </View>
              )}

              <View style={styles.fields}>
                <View style={{ flex: 1.1, gap: 6 }}>
                  <Text style={styles.fieldLabel}>Date d&apos;expiration</Text>
                  <TextInput
                    value={expiry}
                    onChangeText={(t) => setExpiry(maskDate(t))}
                    placeholder="JJ/MM/AAAA"
                    placeholderTextColor={colors.subtle}
                    keyboardType="number-pad"
                    maxLength={10}
                    style={styles.input}
                    accessibilityLabel="Date d'expiration"
                  />
                </View>
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={styles.fieldLabel}>Numéro (facultatif)</Text>
                  <TextInput
                    value={number}
                    onChangeText={setNumber}
                    placeholder="—"
                    placeholderTextColor={colors.subtle}
                    autoCapitalize="characters"
                    maxLength={60}
                    style={styles.input}
                    accessibilityLabel="Numéro du document"
                  />
                </View>
              </View>

              {error && (
                <View style={styles.error} accessibilityLiveRegion="assertive">
                  <Ionicons name="alert-circle" size={20} color={colors.red} />
                  <Text style={styles.errorBoxText}>{error}</Text>
                </View>
              )}

              <BigButton title="Envoyer à la centrale" icon="send" height={60} onPress={() => void submit()} loading={busy} disabled={!picked} />
            </SafeAreaView>
          </Sheet>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  errorText: { color: colors.red, fontSize: 15, textAlign: "center" },
  summary: { flexDirection: "row", alignItems: "center", gap: 14, padding: 16, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1 },
  summaryIcon: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  summaryTitle: { color: colors.fg, fontSize: 17, fontWeight: "900" },
  summarySub: { color: colors.muted, fontSize: 13.5, marginTop: 2 },
  card: { backgroundColor: colors.surface, borderRadius: 20, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 12 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardIcon: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  cardTitle: { color: colors.fg, fontSize: 17, fontWeight: "800" },
  cardSub: { color: colors.subtle, fontSize: 13.5, fontVariant: ["tabular-nums"] },
  stateRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  smallAction: { flexDirection: "row", alignItems: "center", gap: 6, height: 38, paddingHorizontal: 14, borderRadius: 19, backgroundColor: colors.surface3 },
  smallActionText: { color: colors.fg, fontSize: 14, fontWeight: "800" },
  state: { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99 },
  stateDot: { width: 7, height: 7, borderRadius: 4 },
  stateText: { fontSize: 13.5, fontWeight: "800" },
  reason: { flexDirection: "row", gap: 8, padding: 12, borderRadius: 14, backgroundColor: "rgba(242,85,90,0.1)" },
  reasonText: { flex: 1, color: colors.fg, fontSize: 14, lineHeight: 19 },
  pendingText: { color: colors.muted, fontSize: 13.5 },
  footnote: { color: colors.subtle, fontSize: 12.5, textAlign: "center", marginTop: 6, paddingHorizontal: 20 },
  backdrop: { backgroundColor: "rgba(4,5,7,0.62)" },
  sheetWrap: { position: "absolute", left: 0, right: 0, bottom: 0 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  sheetTitle: { color: colors.fg, fontSize: 23, fontWeight: "900", letterSpacing: -0.3 },
  sheetSub: { color: colors.muted, fontSize: 14, marginTop: 4 },
  close: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
  pickRow: { flexDirection: "row", gap: 10 },
  pick: { flex: 1, height: 104, borderRadius: 20, alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.lineStrong, borderStyle: "dashed" },
  pickMain: { backgroundColor: colors.brand, borderColor: colors.brand, borderStyle: "solid" },
  pickText: { color: colors.fg, fontSize: 15, fontWeight: "800" },
  preview: { height: 170, borderRadius: 20, overflow: "hidden", backgroundColor: colors.surface2 },
  previewImg: { width: "100%", height: "100%" },
  previewReset: { position: "absolute", right: 10, bottom: 10, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, height: 36, borderRadius: 18, backgroundColor: "rgba(10,11,14,0.85)" },
  previewResetText: { color: colors.fg, fontSize: 13.5, fontWeight: "800" },
  fields: { flexDirection: "row", gap: 10 },
  fieldLabel: { color: colors.subtle, fontSize: 12.5, fontWeight: "700" },
  input: { height: 50, borderRadius: 14, paddingHorizontal: 14, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, color: colors.fg, fontSize: 16, fontVariant: ["tabular-nums"] },
  error: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 16, backgroundColor: "rgba(242,85,90,0.12)", borderWidth: 1, borderColor: "rgba(242,85,90,0.3)" },
  errorBoxText: { flex: 1, color: colors.fg, fontSize: 14.5, fontWeight: "700", lineHeight: 20 },
});
