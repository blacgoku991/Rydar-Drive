// Inscription d'un chauffeur par le lien d'une centrale ou d'une flotte : https://DOMAINE/rejoindre/{code} (lien
// universel) ou rydardrive://rejoindre/{code}. Le serveur applique les mêmes contrôles que la page web
// (bannis, doublons, limitation de débit), puis le chauffeur est connecté et rattaché à l'organisation.
// Textes selon le modèle renvoyé par le serveur (JS seul : mise à jour EAS).
// Champs identiques à ceux de la connexion : libellé au-dessus, cadre de 56 px, bordure lime au focus.
import { Ionicons } from "@expo/vector-icons";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META, type VehicleCategory } from "@rydar/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Notice } from "@/components/auth";
import { frTypo } from "@/components/centrale";
import { BigButton, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { fetchJoinCentrale, joinCentrale, legalUrl, signIn, type JoinCentrale } from "@/lib/api";
import { colors, control, mono, radius, space, type, weight } from "@/theme";

type Form = {
  firstName: string; lastName: string; phone: string; email: string; password: string; vtcCardNumber: string;
  brand: string; model: string; color: string; plate: string; category: VehicleCategory; seats: string; luggage: string;
};

const EMPTY: Form = {
  firstName: "", lastName: "", phone: "", email: "", password: "", vtcCardNumber: "",
  brand: "", model: "", color: "", plate: "", category: "standard", seats: "4", luggage: "3",
};

/** Agrandissement maximal du texte (réglage « Taille du texte ») : titres et champs restent dans leur cadre. */
const TITLE_SCALE = 1.3;
const INPUT_SCALE = 1.4;

type FieldProps = Omit<TextInputProps, "style"> & {
  label: string;
  error?: string;
  /** Aide sous le champ (remplacée par l'erreur). */
  help?: string;
  /** Mot de passe : masqué, avec bouton « afficher ». */
  secure?: boolean;
  inputStyle?: StyleProp<TextStyle>;
};

/**
 * Champ : libellé au-dessus (nom du champ pour le lecteur d'écran), cadre de 56 px, bordure lime au focus,
 * rouge en erreur ; l'erreur s'affiche sous le champ et fait partie de sa description vocale.
 */
function Field({ label, error, help, secure, inputStyle, onFocus, onBlur, keyboardType, ...input }: FieldProps) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const note = error ? frTypo(error) : help;
  const border = error ? colors.red : focused ? colors.brand : colors.lineStrong;
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label} accessible={false} accessibilityElementsHidden importantForAccessibility="no">
        {label}
      </Text>
      <View style={[styles.field, { borderColor: border }]}>
        <TextInput
          placeholderTextColor={colors.muted}
          selectionColor={colors.brand}
          cursorColor={colors.brand}
          keyboardAppearance="dark"
          maxFontSizeMultiplier={INPUT_SCALE}
          accessibilityLabel={label}
          accessibilityHint={note}
          secureTextEntry={secure && hidden}
          // Android : mot de passe affiché → clavier sans suggestions ni mémorisation
          keyboardType={secure && !hidden && Platform.OS === "android" ? "visible-password" : keyboardType}
          {...input}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, inputStyle]}
        />
        {secure && (
          <Pressable
            onPress={() => setHidden((h) => !h)}
            style={({ pressed }) => [styles.fieldAction, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={hidden ? "Afficher le mot de passe" : "Masquer le mot de passe"}
          >
            <Ionicons name={hidden ? "eye-outline" : "eye-off-outline"} size={22} color={colors.muted} />
          </Pressable>
        )}
      </View>
      {!!note && (
        // Déjà lu avec le champ (accessibilityHint) : masqué au lecteur d'écran pour ne pas l'entendre deux fois
        <Text style={[styles.note, !!error && styles.noteError]} accessibilityElementsHidden importantForAccessibility="no">
          {note}
        </Text>
      )}
    </View>
  );
}

function Section({ title }: { title: string }) {
  return (
    <Text style={styles.section} accessibilityRole="header" maxFontSizeMultiplier={TITLE_SCALE}>
      {title}
    </Text>
  );
}

export default function JoinScreen() {
  const { code: rawCode } = useLocalSearchParams<{ code: string }>();
  const code = String(rawCode ?? "").toLowerCase();
  const { session, ready, signOut } = useDriver();
  const [centrale, setCentrale] = useState<JoinCentrale | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [accept, setAccept] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchJoinCentrale(code)
      .then((c) => alive && setCentrale(c))
      .catch((e: Error) => alive && setLinkError(e.message));
    return () => {
      alive = false;
    };
  }, [code]);

  const set = (k: keyof Form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const leave = () => router.replace(session ? "/" : "/login");

  async function submit() {
    setError(null);
    setErrors({});
    if (!accept) {
      setError("Acceptez les conditions pour continuer.");
      return;
    }
    setLoading(true);
    const res = await joinCentrale(code, {
      firstName: form.firstName, lastName: form.lastName, phone: form.phone, email: form.email, password: form.password,
      vtcCardNumber: form.vtcCardNumber || undefined,
      vehicle: {
        brand: form.brand || undefined, model: form.model, color: form.color || undefined, plate: form.plate,
        category: form.category, seats: Number(form.seats) || 4, luggageCapacity: Number(form.luggage) || 0,
      },
      acceptTerms: true,
    });
    if (!res.ok) {
      setErrors(res.fieldErrors ?? {});
      setError(res.error);
      setLoading(false);
      return;
    }
    try {
      // Compte créé : connexion directe ; candidature en attente → écran d'état du compte
      await signIn(res.email || form.email, form.password);
      router.replace("/");
    } catch {
      router.replace("/login");
    }
  }

  const org = centrale?.organization;
  return (
    <Screen>
      <SafeAreaView style={styles.fill} edges={["top", "bottom"]}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.fill}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <Pressable
              onPress={leave}
              style={({ pressed }) => [styles.back, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Retour"
            >
              <Ionicons name="chevron-back" size={22} color={colors.fg} />
            </Pressable>

            {!org && !linkError && (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.muted} accessibilityLabel="Chargement de l'invitation" />
              </View>
            )}

            {linkError && (
              <View style={styles.head}>
                <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={TITLE_SCALE}>
                  Lien invalide ou désactivé
                </Text>
                <Notice tone="warning" icon="link-outline" message={frTypo(linkError)} />
                <BigButton title={session ? "Retour à l'accueil" : "Retour à la connexion"} variant="secondary" height={control.md} onPress={leave} />
              </View>
            )}

            {org && (
              <>
                <View style={styles.head}>
                  <Text style={styles.kicker}>Inscription chauffeur VTC</Text>
                  <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={TITLE_SCALE}>
                    Rejoindre {org.name}
                  </Text>
                  <Text style={styles.lead}>
                    {org.city ? `${org.city} · ` : ""}
                    {centrale.autoApprove
                      ? "Votre compte est actif dès l'inscription."
                      : centrale.model === "fleet"
                        ? `${org.name} valide votre profil, puis vous recevez les courses.`
                        : "La centrale valide votre profil, puis vous recevez les courses."}
                  </Text>
                </View>

                {ready && session ? (
                  <View style={styles.card}>
                    <Text style={styles.lead}>
                      {frTypo(
                        `Vous êtes déjà connecté à un compte chauffeur. Pour vous inscrire ${centrale.model === "fleet" ? `chez ${org.name}` : "dans cette centrale"}, déconnectez-vous d'abord.`,
                      )}
                    </Text>
                    <BigButton title="Se déconnecter" variant="secondary" height={control.md} onPress={() => void signOut()} />
                  </View>
                ) : (
                  <>
                    <Section title="Identité" />
                    <Field label="Prénom" value={form.firstName} onChangeText={set("firstName")} autoComplete="given-name" error={errors.firstName} />
                    <Field label="Nom" value={form.lastName} onChangeText={set("lastName")} autoComplete="family-name" error={errors.lastName} />
                    <Field label="Téléphone" value={form.phone} onChangeText={set("phone")} keyboardType="phone-pad" autoComplete="tel" inputStyle={mono} error={errors.phone} />
                    <Field label="N° carte VTC (facultatif)" value={form.vtcCardNumber} onChangeText={set("vtcCardNumber")} autoCapitalize="characters" autoCorrect={false} error={errors.vtcCardNumber} />

                    <Section title="Connexion à l'application" />
                    <Field
                      label="E-mail"
                      value={form.email}
                      onChangeText={set("email")}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="email"
                     
                      error={errors.email}
                    />
                    <Field
                      label="Mot de passe"
                      help="10 caractères minimum"
                      value={form.password}
                      onChangeText={set("password")}
                      secure
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="new-password"
                     
                      error={errors.password}
                    />

                    <Section title="Véhicule" />
                    <Field label="Marque" value={form.brand} onChangeText={set("brand")} error={errors["vehicle.brand"]} />
                    <Field label="Modèle" value={form.model} onChangeText={set("model")} error={errors["vehicle.model"]} />
                    <Field label="Couleur" value={form.color} onChangeText={set("color")} error={errors["vehicle.color"]} />
                    <Field label="Plaque" value={form.plate} onChangeText={set("plate")} autoCapitalize="characters" autoCorrect={false} inputStyle={mono} error={errors["vehicle.plate"]} />
                    <View style={styles.fieldWrap}>
                      <Text style={styles.label} accessible={false} accessibilityElementsHidden importantForAccessibility="no">
                        Catégorie
                      </Text>
                      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Catégorie du véhicule">
                        {VEHICLE_CATEGORIES.map((c) => {
                          const active = form.category === c;
                          return (
                            <Pressable
                              key={c}
                              onPress={() => setForm((f) => ({ ...f, category: c }))}
                              style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && !active && styles.pressed]}
                              accessibilityRole="radio"
                              accessibilityLabel={VEHICLE_CATEGORY_META[c].label}
                              accessibilityState={{ checked: active, selected: active }}
                            >
                              <Text style={[styles.chipText, active && styles.chipTextActive]}>{VEHICLE_CATEGORY_META[c].label}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                    <View style={styles.row}>
                      <View style={styles.fill}>
                        <Field label="Places" value={form.seats} onChangeText={set("seats")} keyboardType="number-pad" inputStyle={mono} error={errors["vehicle.seats"]} />
                      </View>
                      <View style={styles.fill}>
                        <Field label="Bagages" value={form.luggage} onChangeText={set("luggage")} keyboardType="number-pad" inputStyle={mono} error={errors["vehicle.luggageCapacity"]} />
                      </View>
                    </View>

                    <Pressable
                      onPress={() => setAccept((a) => !a)}
                      style={({ pressed }) => [styles.accept, pressed && styles.pressed]}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: accept }}
                    >
                      <Ionicons name={accept ? "checkbox" : "square-outline"} size={24} color={accept ? colors.brand : colors.muted} />
                      <Text style={styles.acceptText}>
                        {frTypo(
                          `J'accepte les conditions d'utilisation de Rydar Drive et que ${org.name} traite mes données pour gérer mon activité de chauffeur, et je certifie être chauffeur VTC en règle.`,
                        )}
                      </Text>
                    </Pressable>
                    <View style={styles.legalRow}>
                      {([["cgu", "Conditions d'utilisation"], ["confidentialite", "Confidentialité"]] as const).map(([page, label]) => {
                        const url = legalUrl(page);
                        return url ? (
                          <Pressable key={page} onPress={() => void Linking.openURL(url).catch(() => null)} hitSlop={8} accessibilityRole="link">
                            <Text style={styles.legalLink}>{label}</Text>
                          </Pressable>
                        ) : null;
                      })}
                    </View>

                    {error && <Notice tone="error" message={frTypo(error)} />}

                    <BigButton
                      title={centrale.autoApprove ? "Créer mon compte" : "Envoyer ma candidature"}
                      loading={loading}
                      disabled={!form.firstName || !form.lastName || !form.phone || !form.email || form.password.length < 10 || !form.model || !form.plate}
                      onPress={submit}
                    />
                  </>
                )}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  pressed: { opacity: 0.6 },
  scroll: { padding: space.lg + 4, gap: space.lg + 2, paddingBottom: space.xxl + 16 },
  back: {
    width: control.sm, height: control.sm, borderRadius: radius.full, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surface2, marginLeft: -space.xs,
  },
  loading: { paddingTop: 80, alignItems: "center" },
  head: { gap: space.sm },
  kicker: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  title: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3, lineHeight: 30 },
  lead: { color: colors.muted, fontSize: type.body, lineHeight: 22 },
  section: {
    color: colors.fg, fontSize: type.headline, fontWeight: weight.semibold,
    marginTop: space.sm, paddingTop: space.lg + 2, borderTopWidth: 1, borderColor: colors.line,
  },
  fieldWrap: { gap: space.sm },
  label: { color: colors.muted, fontSize: type.footnote, fontWeight: weight.semibold },
  field: {
    flexDirection: "row", alignItems: "center", minHeight: control.md, borderRadius: radius.md, borderWidth: 1,
    backgroundColor: colors.surface, paddingLeft: space.lg,
  },
  input: {
    flex: 1, alignSelf: "stretch", minHeight: control.md - 2, paddingVertical: 0, paddingHorizontal: 0, paddingRight: space.lg,
    color: colors.fg, fontSize: type.callout, fontWeight: weight.medium,
    // Aperçu web : pas de contour de focus du navigateur (la bordure du champ l'indique déjà)
    ...(Platform.OS === "web" ? { outlineWidth: 0 } : null),
  },
  fieldAction: { width: control.sm, height: control.sm, alignItems: "center", justifyContent: "center", marginRight: space.xs, borderRadius: radius.md },
  note: { color: colors.muted, fontSize: type.footnote, lineHeight: 18 },
  noteError: { color: colors.red, fontWeight: weight.medium },
  card: { gap: space.md, padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: {
    minHeight: control.sm, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong,
    justifyContent: "center", backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { color: colors.fg, fontSize: type.body, fontWeight: weight.medium },
  chipTextActive: { color: colors.brandFg, fontWeight: weight.semibold },
  row: { flexDirection: "row", gap: space.md },
  accept: { flexDirection: "row", gap: space.md, alignItems: "flex-start", minHeight: control.sm, paddingVertical: space.xs, marginTop: space.xs },
  acceptText: { flex: 1, color: colors.muted, fontSize: type.body, lineHeight: 21 },
  legalRow: { flexDirection: "row", flexWrap: "wrap", gap: space.lg, paddingLeft: 24 + space.md, marginTop: -space.xs },
  legalLink: { color: colors.fg, fontSize: type.footnote, textDecorationLine: "underline", paddingVertical: space.xs },
});
