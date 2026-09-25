// État du compte hors « actif » (driver_account_state) :
//  - candidature en attente (inscription par lien) : étapes, dépôt des justificatifs, vérification toutes les 20 s
//    et bascule vers l'accueil dès la validation par la centrale ;
//  - refusé, banni, suspendu, désactivé, centrale suspendue… : écran bloquant avec le motif,
//    appel de la centrale et déconnexion.
import { Ionicons } from "@expo/vector-icons";
import { TRUST_LEVEL_META, formatDate, formatTime, type DriverAccountState, type DriverAccountStateKind } from "@rydar/shared";
import { Redirect, router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { buildDocEntries, DocCard, DocumentsSummary, isTodo, UploadSheet, useDriverDocuments, type DocEntry } from "@/components/documents";
import { frTypo } from "@/components/centrale";
import { RadarPulse } from "@/components/radar";
import { BigButton, Screen, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { colors } from "@/theme";

/** Vérification automatique de la candidature (validation par la centrale). */
const POLL_MS = 20_000;

const telUrl = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

export default function AccountScreen() {
  const { ready, session, account, canDrive } = useDriver();
  const wasPending = useRef(false);
  if (account?.state === "pending") wasPending.current = true;

  if (!ready) return null;
  if (!session) return <Redirect href="/login" />;
  // Candidature validée pendant l'attente : écran de bienvenue avant l'accueil
  if (canDrive && wasPending.current && account) return <Welcome account={account} />;
  if (canDrive) return <Redirect href="/home" />;
  if (!account) return null;
  if (account.state === "pending") return <PendingApplication account={account} />;
  return <AccountBlocked account={account} />;
}

// -----------------------------------------------------------------------------
// Candidature en attente
// -----------------------------------------------------------------------------
type StepState = "done" | "current" | "todo";

function PendingApplication({ account }: { account: DriverAccountState }) {
  const { session, checkAccount, signOut } = useDriver();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 12);
  const { data, error, load } = useDriverDocuments(account.can_submit_documents !== false);
  const entries = useMemo(() => buildDocEntries(data), [data]);
  const [editing, setEditing] = useState<DocEntry | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checkedAt, setCheckedAt] = useState(Date.now());
  const [orgId, setOrgId] = useState<string | undefined>();
  const [leaving, setLeaving] = useState(false);
  const orgName = account.organization?.name ?? "votre centrale";
  const phone = account.organization?.phone ?? null;
  const userId = session?.user.id;

  // Dossier de stockage des justificatifs : <organisation>/<chauffeur>/ (fiche lisible par son titulaire)
  useEffect(() => {
    if (!userId) return;
    api.myDriverRow(userId).then((r) => setOrgId(r?.organization_id)).catch(() => null);
  }, [userId]);

  const check = useCallback(async () => {
    await Promise.all([checkAccount(), load()]);
    setCheckedAt(Date.now());
  }, [checkAccount, load]);

  // Validation par la centrale : vérifiée toutes les 20 s (app au premier plan)
  useEffect(() => {
    const t = setInterval(() => {
      if (AppState.currentState === "active") void check();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [check]);

  const todo = entries.filter((e) => isTodo(e.state));
  const sent = entries.filter((e) => !isTodo(e.state));
  const docsDone = data != null && todo.length === 0;
  const steps: { title: string; sub: string; state: StepState }[] = [
    {
      title: "Compte créé",
      sub: account.driver?.applied_at ? `Candidature envoyée le ${formatDate(account.driver.applied_at)}` : "Candidature envoyée",
      state: "done",
    },
    {
      title: "Vos justificatifs",
      sub: data == null
        ? "Chargement de votre dossier…"
        : docsDone
          ? "Dossier complet — en cours de vérification"
          : `${todo.length} justificatif${todo.length > 1 ? "s" : ""} à ajouter ou mettre à jour`,
      state: docsDone ? "done" : "current",
    },
    { title: "Validation par la centrale", sub: `${orgName} vérifie votre dossier et votre véhicule`, state: docsDone ? "current" : "todo" },
    { title: "Premières courses", sub: frTypo(`Passez en ligne. Statut « Nouveau » au début : ${TRUST_LEVEL_META.new.description.charAt(0).toLowerCase()}${TRUST_LEVEL_META.new.description.slice(1)}`), state: "todo" },
  ];

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: 18, gap: 14, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              tintColor={colors.brand}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await check();
                setRefreshing(false);
              }}
            />
          }
        >
          <View style={styles.hero}>
            <View style={styles.heroIconWrap}>
              <RadarPulse size={150} color={colors.amber} />
              <View style={[styles.heroIcon, { borderColor: "rgba(245,181,68,0.6)", backgroundColor: "rgba(245,181,68,0.1)" }]}>
                <Ionicons name="hourglass" size={30} color={colors.amber} />
              </View>
            </View>
            <Text style={styles.kicker}>Candidature envoyée</Text>
            <Text style={styles.heroTitle}>à {orgName}</Text>
            <Text style={styles.heroSub}>
              La centrale valide votre inscription. Ajoutez vos justificatifs dès maintenant pour accélérer la validation.
            </Text>
            <View style={styles.checkRow} accessibilityLiveRegion="polite">
              <View style={styles.liveDot} />
              <Text style={styles.checkText}>Vérifié à {formatTime(new Date(checkedAt))} · actualisation automatique</Text>
            </View>
          </View>

          {/* Étapes */}
          <View style={styles.stepsCard}>
            {steps.map((s, i) => (
              <Step key={s.title} index={i} last={i === steps.length - 1} {...s} />
            ))}
          </View>

          {/* Ce qui reste à faire */}
          <Text style={styles.section}>{todo.length > 0 ? "Ce qui reste à faire" : "Vos justificatifs"}</Text>
          {!data ? (
            <View style={{ paddingVertical: 36, alignItems: "center" }}>
              {error ? <Text style={styles.errorText}>{error}</Text> : <ActivityIndicator color={colors.brand} />}
            </View>
          ) : (
            <>
              <DocumentsSummary data={data} entries={entries} />
              {todo.map((e) => (
                <DocCard key={e.key} entry={e} onUpdate={() => setEditing(e)} />
              ))}
              {sent.length > 0 && todo.length > 0 && <Text style={styles.section}>Déjà envoyés</Text>}
              {sent.map((e) => (
                <DocCard key={e.key} entry={e} onUpdate={() => setEditing(e)} />
              ))}
            </>
          )}

          <View style={{ gap: 10, marginTop: 8 }}>
            {phone ? (
              <BigButton title="Appeler la centrale" icon="call" variant="secondary" height={56} onPress={() => void Linking.openURL(telUrl(phone)).catch(() => null)} />
            ) : null}
            <BigButton
              title="Se déconnecter"
              variant="ghost"
              height={50}
              loading={leaving}
              onPress={async () => {
                setLeaving(true);
                await signOut();
                router.replace("/login");
              }}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
      {flash.node}
      <UploadSheet
        entry={editing}
        orgId={orgId}
        driverId={account.driver?.id}
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

function Step({ index, title, sub, state, last }: { index: number; title: string; sub: string; state: StepState; last: boolean }) {
  const color = state === "done" ? colors.green : state === "current" ? colors.amber : colors.subtle;
  return (
    <View style={styles.step} accessibilityLabel={`Étape ${index + 1} : ${title}, ${state === "done" ? "faite" : state === "current" ? "en cours" : "à venir"}`}>
      <View style={styles.stepRail}>
        <View style={[styles.stepDot, { borderColor: color, backgroundColor: state === "done" ? color : state === "current" ? "rgba(245,181,68,0.14)" : "transparent" }]}>
          {state === "done" ? (
            <Ionicons name="checkmark" size={16} color={colors.bg} />
          ) : (
            <Text style={[styles.stepNum, { color }]}>{index + 1}</Text>
          )}
        </View>
        {!last && <View style={[styles.stepLine, { backgroundColor: state === "done" ? "rgba(79,213,143,0.45)" : colors.line }]} />}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : 18 }}>
        <Text style={[styles.stepTitle, state === "todo" && { color: colors.muted }]}>{title}</Text>
        <Text style={styles.stepSub}>{sub}</Text>
      </View>
    </View>
  );
}

// -----------------------------------------------------------------------------
// Candidature validée pendant l'attente
// -----------------------------------------------------------------------------
function Welcome({ account }: { account: DriverAccountState }) {
  return (
    <Screen style={styles.center}>
      <SafeAreaView style={styles.centerInner}>
        <View style={styles.heroIconWrap}>
          <RadarPulse size={200} />
          <View style={[styles.heroIcon, styles.heroIconBig, { borderColor: colors.brand, backgroundColor: "rgba(200,240,60,0.1)" }]}>
            <Ionicons name="checkmark" size={44} color={colors.brand} />
          </View>
        </View>
        <Text style={[styles.kicker, { color: colors.brand }]}>Candidature acceptée</Text>
        <Text style={[styles.heroTitle, { textAlign: "center" }]}>Bienvenue chez {account.organization?.name ?? "votre centrale"}</Text>
        <Text style={[styles.heroSub, { textAlign: "center" }]}>
          {frTypo(`Passez en ligne pour recevoir vos premières courses. ${TRUST_LEVEL_META.new.label} au début : ${TRUST_LEVEL_META.new.description.toLowerCase()}`)}
        </Text>
        <BigButton title="C'est parti" icon="arrow-forward" onPress={() => router.replace("/home")} style={{ alignSelf: "stretch", marginTop: 12 }} />
      </SafeAreaView>
    </Screen>
  );
}

// -----------------------------------------------------------------------------
// Compte refusé, banni, suspendu, désactivé… : écran bloquant
// -----------------------------------------------------------------------------
type Blocked = Exclude<DriverAccountStateKind, "active" | "pending">;

const BLOCKED: Record<Blocked, { icon: keyof typeof Ionicons.glyphMap; color: string; title: string; message: (org: string) => string }> = {
  banned: {
    icon: "ban",
    color: colors.red,
    title: "Accès refusé",
    message: (org) => `Ce compte a été banni par ${org}. Vous ne pouvez plus recevoir de courses de cette centrale.`,
  },
  rejected: {
    icon: "close-circle",
    color: colors.red,
    title: "Candidature non retenue",
    message: (org) => `${org} n'a pas retenu votre candidature.`,
  },
  suspended: {
    icon: "pause-circle",
    color: colors.amber,
    title: "Compte suspendu",
    message: (org) => `Votre compte est suspendu par ${org} : vous ne recevez plus de courses. Contactez la centrale.`,
  },
  inactive: {
    icon: "moon",
    color: colors.amber,
    title: "Compte désactivé",
    message: (org) => `Votre compte chauffeur chez ${org} est désactivé. Contactez la centrale pour le réactiver.`,
  },
  invited: {
    icon: "mail-unread",
    color: colors.blue,
    title: "Compte pas encore activé",
    message: (org) => `Votre compte chauffeur chez ${org} n'est pas encore activé. Contactez la centrale.`,
  },
  organization_suspended: {
    icon: "business",
    color: colors.amber,
    title: "Centrale suspendue",
    message: (org) => `Le compte de ${org} est suspendu sur Rydar Drive : aucune course pour le moment.`,
  },
  none: {
    icon: "person-remove",
    color: colors.muted,
    title: "Compte introuvable",
    message: () => "Aucun compte chauffeur n'est associé à cet identifiant.",
  },
};

function AccountBlocked({ account }: { account: DriverAccountState }) {
  const { checkAccount, signOut } = useDriver();
  const [checking, setChecking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const meta = BLOCKED[account.state as Blocked] ?? BLOCKED.inactive;
  const org = account.organization?.name ?? "votre centrale";
  const phone = account.organization?.phone ?? null;
  const email = account.organization?.email ?? null;

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.blockedScroll}>
          <View style={{ alignItems: "center", gap: 10 }}>
            <View style={styles.heroIconWrap}>
              <View style={[styles.halo, { borderColor: `${meta.color}26`, backgroundColor: `${meta.color}08` }]} />
              <View style={[styles.heroIcon, styles.heroIconBig, { borderColor: `${meta.color}99`, backgroundColor: `${meta.color}1A` }]}>
                <Ionicons name={meta.icon} size={40} color={meta.color} />
              </View>
            </View>
            <Text style={[styles.blockedTitle, { color: meta.color }]} accessibilityRole="header">{meta.title}</Text>
            <Text style={styles.blockedText}>{frTypo(meta.message(org))}</Text>
          </View>

          {account.reason ? (
            <View style={[styles.reason, { borderColor: `${meta.color}40`, backgroundColor: `${meta.color}12` }]}>
              <Ionicons name="chatbox-ellipses-outline" size={18} color={meta.color} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.reasonLabel}>Motif indiqué par la centrale</Text>
                <Text style={styles.reasonText}>{frTypo(account.reason)}</Text>
              </View>
            </View>
          ) : null}

          {account.state !== "none" && (
            <View style={styles.orgCard}>
              <View style={styles.orgIcon}>
                <Ionicons name="radio" size={20} color={colors.fg} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.orgName} numberOfLines={1}>{org}</Text>
                <Text style={styles.orgSub} numberOfLines={1}>{phone ?? email ?? "Centrale de réservation"}</Text>
              </View>
            </View>
          )}

          <View style={{ gap: 10, marginTop: "auto" }}>
            {phone ? (
              <BigButton title="Appeler la centrale" icon="call" onPress={() => void Linking.openURL(telUrl(phone)).catch(() => null)} />
            ) : email ? (
              <BigButton title="Écrire à la centrale" icon="mail" onPress={() => void Linking.openURL(`mailto:${email}`).catch(() => null)} />
            ) : null}
            <BigButton
              title="Vérifier à nouveau"
              icon="refresh"
              variant="secondary"
              height={54}
              loading={checking}
              onPress={async () => {
                setChecking(true);
                await checkAccount();
                setChecking(false);
              }}
            />
            <BigButton
              title="Se déconnecter"
              variant="danger"
              height={54}
              loading={leaving}
              onPress={async () => {
                setLeaving(true);
                await signOut();
                router.replace("/login");
              }}
            />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  centerInner: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  hero: { alignItems: "center", paddingTop: 8, gap: 6 },
  heroIconWrap: { width: 150, height: 150, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  heroIcon: { width: 72, height: 72, borderRadius: 36, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  heroIconBig: { width: 92, height: 92, borderRadius: 46 },
  halo: { position: "absolute", width: 146, height: 146, borderRadius: 73, borderWidth: 1.5 },
  kicker: { color: colors.amber, fontSize: 14, fontWeight: "900", letterSpacing: 1.2, textTransform: "uppercase" },
  heroTitle: { color: colors.fg, fontSize: 28, fontWeight: "900", letterSpacing: -0.6, textAlign: "center" },
  heroSub: { color: colors.muted, fontSize: 15, lineHeight: 21, textAlign: "center", paddingHorizontal: 6 },
  checkRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99, backgroundColor: colors.surface2 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  checkText: { color: colors.muted, fontSize: 12.5, fontWeight: "700", fontVariant: ["tabular-nums"] },
  stepsCard: { backgroundColor: colors.surface, borderRadius: 22, borderWidth: 1, borderColor: colors.line, padding: 18 },
  step: { flexDirection: "row", gap: 14 },
  stepRail: { alignItems: "center", width: 30 },
  stepDot: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  stepNum: { fontSize: 13, fontWeight: "900" },
  stepLine: { width: 2, flex: 1, marginVertical: 4, borderRadius: 1 },
  stepTitle: { color: colors.fg, fontSize: 16.5, fontWeight: "800", marginTop: 4 },
  stepSub: { color: colors.subtle, fontSize: 13.5, lineHeight: 19, marginTop: 2 },
  section: { color: colors.subtle, fontSize: 13, fontWeight: "800", letterSpacing: 0.6, textTransform: "uppercase", marginTop: 8 },
  errorText: { color: colors.red, fontSize: 15, textAlign: "center" },
  blockedScroll: { flexGrow: 1, padding: 22, gap: 18, paddingTop: 36 },
  blockedTitle: { fontSize: 30, fontWeight: "900", letterSpacing: -0.6, textAlign: "center" },
  blockedText: { color: colors.fg, fontSize: 16.5, lineHeight: 23, textAlign: "center", fontWeight: "600", paddingHorizontal: 4 },
  reason: { flexDirection: "row", gap: 12, padding: 16, borderRadius: 18, borderWidth: 1 },
  reasonLabel: { color: colors.muted, fontSize: 12.5, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  reasonText: { color: colors.fg, fontSize: 15.5, lineHeight: 21, fontWeight: "600" },
  orgCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  orgIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
  orgName: { color: colors.fg, fontSize: 16, fontWeight: "800" },
  orgSub: { color: colors.subtle, fontSize: 13.5, marginTop: 2 },
});
