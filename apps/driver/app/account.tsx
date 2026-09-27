// État du compte hors « actif » (driver_account_state) :
//  - candidature en attente (inscription par lien) : étapes, dépôt des justificatifs, vérification toutes les 20 s
//    et bascule vers l'accueil dès la validation par la centrale ;
//  - refusé, banni, suspendu, désactivé, centrale suspendue… : écran bloquant avec le motif,
//    appel de la centrale, déconnexion et suppression du compte (mot de passe demandé si la session est refusée).
// Sobre : pas d'animation décorative ; la couleur ne sert qu'à l'état (étiquette, pictogramme d'état).
import { Ionicons } from "@expo/vector-icons";
import { TRUST_LEVEL_META, formatDate, formatTime, type DriverAccountState, type DriverAccountStateKind } from "@rydar/shared";
import { Redirect, router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { buildDocEntries, DocCard, DocumentsSummary, needsAction, UploadSheet, useDriverDocuments, type DocEntry } from "@/components/documents";
import { frTypo } from "@/components/centrale";
import { BigButton, Pill, Screen, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api } from "@/lib/api";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

/** Vérification automatique de la candidature (validation par la centrale). */
const POLL_MS = 20_000;

/** Espace insécable (typographie française : avant « : ; ! ? », entre un nombre et son unité). */
const NB = " ";

const telUrl = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

/** « Statut « Nouveau » au début : courses plafonnées en prix jusqu'à la confirmation. » */
const newDriverNote = () => {
  const { label, description } = TRUST_LEVEL_META.new;
  return `Statut « ${label} » au début : ${description.charAt(0).toLowerCase()}${description.slice(1)}`;
};

export default function AccountScreen() {
  const { ready, session, account, canDrive } = useDriver();
  const wasPending = useRef(false);
  if (account?.state === "pending") wasPending.current = true;

  if (!ready) return null;
  if (!session) return <Redirect href="/login" />;
  // Candidature validée pendant l'attente : écran de confirmation avant l'accueil
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

const STEP_STATE_LABEL: Record<StepState, string> = { done: "terminée", current: "en cours", todo: "à venir" };

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

  // Dossier de stockage des justificatifs : <organisation>/<chauffeur>/ — organisation donnée par l'état du compte
  // (relu toutes les 20 s) ; repli pour un serveur qui ne la renvoie pas : fiche lisible par son titulaire
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

  // À traiter ET déposable dans l'application (visite médicale : historique seulement, jamais « à ajouter »)
  const todo = entries.filter(needsAction);
  const sent = entries.filter((e) => !needsAction(e));
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
          ? "Dossier complet, en cours de vérification"
          : `${todo.length}${NB}justificatif${todo.length > 1 ? "s" : ""} à ajouter ou à mettre à jour`,
      state: docsDone ? "done" : "current",
    },
    { title: "Validation par la centrale", sub: `${orgName} vérifie votre dossier et votre véhicule`, state: docsDone ? "current" : "todo" },
    { title: "Premières courses", sub: frTypo(`Passez en ligne. ${newDriverNote()}`), state: "todo" },
  ];

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={styles.fill}>
        <ScrollView
          contentContainerStyle={styles.scroll}
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
          <View style={styles.head}>
            <Pill label="En attente de validation" color={colors.amber} />
            <Text style={styles.title} accessibilityRole="header">
              Candidature envoyée à {orgName}
            </Text>
            <Text style={styles.lead}>
              La centrale valide votre inscription. Ajoutez vos justificatifs dès maintenant pour accélérer la validation.
            </Text>
            <Text style={styles.checked} accessibilityLiveRegion="polite">
              Vérifié à {formatTime(new Date(checkedAt))} · actualisation automatique
            </Text>
          </View>

          {/* Étapes */}
          <View style={styles.card} accessibilityRole="list">
            {steps.map((s, i) => (
              <Step key={s.title} index={i} count={steps.length} {...s} />
            ))}
          </View>

          {/* Ce qui reste à faire */}
          <Text style={styles.section} accessibilityRole="header">
            {todo.length > 0 ? "Ce qui reste à faire" : "Vos justificatifs"}
          </Text>
          {!data ? (
            <View style={styles.loading}>
              {error ? (
                <Text style={styles.errorText} accessibilityRole="alert">
                  {frTypo(error)}
                </Text>
              ) : (
                <ActivityIndicator color={colors.muted} accessibilityLabel="Chargement des justificatifs" />
              )}
            </View>
          ) : (
            <>
              <DocumentsSummary data={data} entries={entries} />
              {todo.map((e) => (
                <DocCard key={e.key} entry={e} onUpdate={() => setEditing(e)} />
              ))}
              {sent.length > 0 && todo.length > 0 && (
                <Text style={styles.section} accessibilityRole="header">
                  Déjà envoyés
                </Text>
              )}
              {sent.map((e) => (
                <DocCard key={e.key} entry={e} onUpdate={() => setEditing(e)} />
              ))}
            </>
          )}

          <View style={styles.actions}>
            {phone ? (
              <BigButton
                title="Appeler la centrale"
                icon="call-outline"
                variant="secondary"
                height={control.md}
                onPress={() => void Linking.openURL(telUrl(phone)).catch(() => null)}
              />
            ) : null}
            <BigButton
              title="Se déconnecter"
              variant="ghost"
              height={control.sm}
              loading={leaving}
              onPress={async () => {
                setLeaving(true);
                await signOut();
                router.replace("/login");
              }}
            />
            <BigButton title="Supprimer mon compte" variant="ghost" height={control.sm} onPress={() => router.push("/delete-account")} />
          </View>
        </ScrollView>
      </SafeAreaView>
      {flash.node}
      <UploadSheet
        entry={editing}
        orgId={account.organization?.id ?? orgId}
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

function Step({ index, count, title, sub, state }: { index: number; count: number; title: string; sub: string; state: StepState }) {
  const last = index === count - 1;
  const ring = state === "done" ? colors.green : state === "current" ? colors.amber : colors.lineStrong;
  return (
    <View
      style={styles.step}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Étape ${index + 1} sur ${count}${NB}: ${title}, ${STEP_STATE_LABEL[state]}. ${sub}`}
    >
      <View style={styles.stepRail}>
        <View style={[styles.stepDot, { borderColor: ring }, state === "done" && { backgroundColor: colors.green }]}>
          {state === "done" ? (
            <Ionicons name="checkmark" size={16} color={colors.bg} />
          ) : (
            <Text style={[styles.stepNum, { color: state === "current" ? colors.amber : colors.muted }]}>{index + 1}</Text>
          )}
        </View>
        {!last && <View style={styles.stepLine} />}
      </View>
      <View style={[styles.stepBody, !last && { paddingBottom: space.lg }]}>
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
    <Screen>
      <SafeAreaView style={styles.single}>
        <View style={styles.singleBody}>
          <Ionicons name="checkmark-circle-outline" size={44} color={colors.green} accessibilityElementsHidden importantForAccessibility="no" />
          <View style={styles.singleText}>
            <Text style={styles.title} accessibilityRole="header">
              Candidature acceptée
            </Text>
            <Text style={styles.org} numberOfLines={2}>
              {account.organization?.name ?? "Votre centrale"}
            </Text>
          </View>
          <Text style={styles.lead}>{frTypo(`Passez en ligne pour recevoir vos premières courses. ${newDriverNote()}`)}</Text>
        </View>
        <BigButton title="Aller à l'accueil" onPress={() => router.replace("/home")} />
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
    icon: "ban-outline",
    color: colors.red,
    title: "Accès refusé",
    message: (org) => `Ce compte a été banni par ${org}. Vous ne pouvez plus recevoir de courses de cette centrale.`,
  },
  rejected: {
    icon: "close-circle-outline",
    color: colors.red,
    title: "Candidature non retenue",
    message: (org) => `${org} n'a pas retenu votre candidature.`,
  },
  suspended: {
    icon: "pause-circle-outline",
    color: colors.amber,
    title: "Compte suspendu",
    message: (org) => `Votre compte est suspendu par ${org} : vous ne recevez plus de courses. Contactez la centrale.`,
  },
  inactive: {
    icon: "moon-outline",
    color: colors.amber,
    title: "Compte désactivé",
    message: (org) => `Votre compte chauffeur chez ${org} est désactivé. Contactez la centrale pour le réactiver.`,
  },
  invited: {
    icon: "mail-unread-outline",
    color: colors.blue,
    title: "Compte pas encore activé",
    message: (org) => `Votre compte chauffeur chez ${org} n'est pas encore activé. Contactez la centrale.`,
  },
  organization_suspended: {
    icon: "business-outline",
    color: colors.amber,
    title: "Centrale suspendue",
    message: (org) => `Le compte de ${org} est suspendu sur Rydar Drive : aucune course pour le moment.`,
  },
  none: {
    icon: "person-remove-outline",
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
      <SafeAreaView style={styles.fill}>
        <ScrollView contentContainerStyle={styles.blockedScroll}>
          <View style={styles.singleBody}>
            <Ionicons name={meta.icon} size={40} color={meta.color} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={styles.title} accessibilityRole="header">
              {meta.title}
            </Text>
            <Text style={styles.message}>{frTypo(meta.message(org))}</Text>
          </View>

          {account.reason ? (
            <View style={styles.row} accessible accessibilityLabel={`Motif indiqué par la centrale${NB}: ${account.reason}`}>
              <Ionicons name="chatbox-ellipses-outline" size={20} color={colors.muted} />
              <View style={styles.rowBody}>
                <Text style={styles.rowLabel}>Motif indiqué par la centrale</Text>
                <Text style={styles.rowText}>{frTypo(account.reason)}</Text>
              </View>
            </View>
          ) : null}

          {account.state !== "none" && (
            <View style={styles.row} accessible accessibilityLabel={`Centrale${NB}: ${org}. ${phone ?? email ?? ""}`}>
              <Ionicons name="business-outline" size={20} color={colors.muted} />
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {org}
                </Text>
                <Text style={[styles.rowSub, !!phone && mono]} numberOfLines={1}>
                  {phone ?? email ?? "Centrale de réservation"}
                </Text>
              </View>
            </View>
          )}

          <View style={[styles.actions, { marginTop: "auto" }]}>
            {phone ? (
              <BigButton title="Appeler la centrale" icon="call-outline" height={control.md} onPress={() => void Linking.openURL(telUrl(phone)).catch(() => null)} />
            ) : email ? (
              <BigButton title="Écrire à la centrale" icon="mail-outline" height={control.md} onPress={() => void Linking.openURL(`mailto:${email}`).catch(() => null)} />
            ) : null}
            <BigButton
              title="Vérifier à nouveau"
              icon="refresh-outline"
              variant="secondary"
              height={control.md}
              loading={checking}
              onPress={async () => {
                setChecking(true);
                await checkAccount();
                setChecking(false);
              }}
            />
            <BigButton
              title="Se déconnecter"
              variant="ghost"
              height={control.sm}
              loading={leaving}
              onPress={async () => {
                setLeaving(true);
                await signOut();
                router.replace("/login");
              }}
            />
            {/* Aussi pour un compte suspendu, banni ou d'une centrale suspendue : session refusée par le serveur →
                l'écran demande le mot de passe. Sans fiche chauffeur (« none »), rien à supprimer. */}
            {account.state !== "none" && (
              <BigButton title="Supprimer mon compte" variant="ghost" height={control.sm} onPress={() => router.push("/delete-account")} />
            )}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { padding: space.lg + 4, gap: space.lg, paddingBottom: space.xxl + 8 },
  head: { gap: space.sm, paddingTop: space.sm },
  title: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3, lineHeight: 30 },
  lead: { color: colors.muted, fontSize: type.body, lineHeight: 22 },
  checked: { color: colors.muted, fontSize: type.footnote, ...mono },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg },
  step: { flexDirection: "row", gap: space.md + 2 },
  stepRail: { alignItems: "center", width: 28 },
  stepDot: { width: 28, height: 28, borderRadius: radius.full, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  stepNum: { fontSize: type.footnote, fontWeight: weight.semibold, ...mono },
  stepLine: { width: 2, flex: 1, marginVertical: space.xs, borderRadius: 1, backgroundColor: colors.line },
  stepBody: { flex: 1, gap: 2, paddingTop: 3 },
  stepTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  stepSub: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
  section: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold, marginTop: space.sm },
  loading: { paddingVertical: space.xxl, alignItems: "center" },
  errorText: { color: colors.fg, fontSize: type.body, lineHeight: 21, textAlign: "center" },
  actions: { gap: space.sm + 2, marginTop: space.sm },
  single: { flex: 1, padding: space.xl, gap: space.xl, justifyContent: "space-between" },
  singleBody: { gap: space.md, paddingTop: space.xl },
  singleText: { gap: space.xs },
  org: { color: colors.fg, fontSize: type.headline, fontWeight: weight.medium },
  blockedScroll: { flexGrow: 1, padding: space.xl, gap: space.lg },
  message: { color: colors.fg, fontSize: type.callout, lineHeight: 23 },
  row: {
    flexDirection: "row", alignItems: "flex-start", gap: space.md, padding: space.lg,
    borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
  },
  rowBody: { flex: 1, gap: 2 },
  rowLabel: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  rowText: { color: colors.fg, fontSize: type.body, lineHeight: 21 },
  rowTitle: { color: colors.fg, fontSize: type.callout, fontWeight: weight.semibold },
  rowSub: { color: colors.muted, fontSize: type.subhead },
});
