// Inscription d'un chauffeur par le lien d'une centrale : https://DOMAINE/rejoindre/{code} (lien universel)
// ou rydardrive://rejoindre/{code}. Le serveur applique les mêmes contrôles que la page web
// (bannis, doublons, limitation de débit), puis le chauffeur est connecté et rattaché à la centrale.
import { Ionicons } from "@expo/vector-icons";
import { VEHICLE_CATEGORIES, VEHICLE_CATEGORY_META, type VehicleCategory } from "@rydar/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { frTypo } from "@/components/centrale";
import { BigButton, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { fetchJoinCentrale, joinCentrale, signIn, type JoinCentrale } from "@/lib/api";
import { colors, radius } from "@/theme";

type Form = {
  firstName: string; lastName: string; phone: string; email: string; password: string; vtcCardNumber: string;
  brand: string; model: string; color: string; plate: string; category: VehicleCategory; seats: string; luggage: string;
};

const EMPTY: Form = {
  firstName: "", lastName: "", phone: "", email: "", password: "", vtcCardNumber: "",
  brand: "", model: "", color: "", plate: "", category: "standard", seats: "4", luggage: "3",
};

function Field({ label, error, ...input }: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.subtle} style={[styles.input, !!error && { borderColor: colors.red }]} {...input} />
      {!!error && <Text style={styles.fieldError}>{frTypo(error)}</Text>}
    </View>
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
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
            <Pressable onPress={() => router.replace(session ? "/" : "/login")} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retour">
              <Ionicons name="chevron-back" size={24} color={colors.fg} />
            </Pressable>

            {!org && !linkError && (
              <View style={{ paddingTop: 80, alignItems: "center" }}>
                <ActivityIndicator color={colors.brand} />
              </View>
            )}

            {linkError && (
              <View style={styles.card}>
                <Ionicons name="link" size={28} color={colors.amber} />
                <Text style={styles.title}>Lien invalide ou désactivé</Text>
                <Text style={styles.muted}>{frTypo(linkError)}</Text>
              </View>
            )}

            {org && (
              <>
                <View style={{ gap: 6 }}>
                  <Text style={styles.kicker}>Inscription chauffeur VTC</Text>
                  <Text style={styles.title}>Rejoindre {org.name}</Text>
                  <Text style={styles.muted}>
                    {org.city ? `${org.city} · ` : ""}
                    {centrale.autoApprove
                      ? "Votre compte est actif dès l'inscription."
                      : "La centrale valide votre profil, puis vous recevez les courses."}
                  </Text>
                </View>

                {ready && session ? (
                  <View style={styles.card}>
                    <Text style={styles.muted}>
                      {frTypo("Vous êtes déjà connecté à un compte chauffeur. Pour vous inscrire dans cette centrale, déconnectez-vous d'abord.")}
                    </Text>
                    <BigButton title="Se déconnecter" variant="secondary" height={52} onPress={() => void signOut()} />
                  </View>
                ) : (
                  <>
                    <Text style={styles.section}>Identité</Text>
                    <Field label="Prénom" value={form.firstName} onChangeText={set("firstName")} autoComplete="given-name" error={errors.firstName} />
                    <Field label="Nom" value={form.lastName} onChangeText={set("lastName")} autoComplete="family-name" error={errors.lastName} />
                    <Field label="Téléphone" value={form.phone} onChangeText={set("phone")} keyboardType="phone-pad" autoComplete="tel" error={errors.phone} />
                    <Field label="N° carte VTC (facultatif)" value={form.vtcCardNumber} onChangeText={set("vtcCardNumber")} autoCapitalize="characters" error={errors.vtcCardNumber} />

                    <Text style={styles.section}>Connexion à l&apos;application</Text>
                    <Field label="E-mail" value={form.email} onChangeText={set("email")} keyboardType="email-address" autoCapitalize="none" autoComplete="email" error={errors.email} />
                    <Field label="Mot de passe (10 caractères minimum)" value={form.password} onChangeText={set("password")} secureTextEntry autoComplete="new-password" error={errors.password} />

                    <Text style={styles.section}>Véhicule</Text>
                    <Field label="Marque" value={form.brand} onChangeText={set("brand")} error={errors["vehicle.brand"]} />
                    <Field label="Modèle" value={form.model} onChangeText={set("model")} error={errors["vehicle.model"]} />
                    <Field label="Couleur" value={form.color} onChangeText={set("color")} error={errors["vehicle.color"]} />
                    <Field label="Plaque" value={form.plate} onChangeText={set("plate")} autoCapitalize="characters" error={errors["vehicle.plate"]} />
                    <View style={{ gap: 6 }}>
                      <Text style={styles.label}>Catégorie</Text>
                      <View style={styles.chips}>
                        {VEHICLE_CATEGORIES.map((c) => {
                          const active = form.category === c;
                          return (
                            <Pressable key={c} onPress={() => setForm((f) => ({ ...f, category: c }))} style={[styles.chip, active && styles.chipActive]} accessibilityRole="radio" accessibilityState={{ selected: active }}>
                              <Text style={[styles.chipText, active && { color: colors.brandFg }]}>{VEHICLE_CATEGORY_META[c].label}</Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    </View>
                    <View style={{ flexDirection: "row", gap: 12 }}>
                      <View style={{ flex: 1 }}>
                        <Field label="Places" value={form.seats} onChangeText={set("seats")} keyboardType="number-pad" error={errors["vehicle.seats"]} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Field label="Bagages" value={form.luggage} onChangeText={set("luggage")} keyboardType="number-pad" error={errors["vehicle.luggageCapacity"]} />
                      </View>
                    </View>

                    <Pressable onPress={() => setAccept((a) => !a)} style={styles.accept} accessibilityRole="checkbox" accessibilityState={{ checked: accept }}>
                      <Ionicons name={accept ? "checkbox" : "square-outline"} size={24} color={accept ? colors.brand : colors.muted} />
                      <Text style={[styles.muted, { flex: 1 }]}>
                        {frTypo(`J'accepte que ${org.name} traite mes données pour gérer mon activité de chauffeur, et je certifie être chauffeur VTC en règle.`)}
                      </Text>
                    </Pressable>

                    {error && (
                      <View style={styles.errorBox} accessibilityRole="alert">
                        <Ionicons name="alert-circle" size={20} color={colors.red} />
                        <Text style={[styles.errorText, { flex: 1 }]}>{frTypo(error)}</Text>
                      </View>
                    )}

                    <BigButton
                      title={centrale.autoApprove ? "Créer mon compte" : "Envoyer ma candidature"}
                      icon="arrow-forward"
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
  kicker: { color: colors.brand, fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  title: { color: colors.fg, fontSize: 26, fontWeight: "800", letterSpacing: -0.4 },
  muted: { color: colors.muted, fontSize: 14.5, lineHeight: 21 },
  section: { color: colors.fg, fontSize: 17, fontWeight: "800", marginTop: 8 },
  label: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  input: { height: 52, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, paddingHorizontal: 14, color: colors.fg, fontSize: 16 },
  fieldError: { color: colors.red, fontSize: 13 },
  card: { gap: 12, padding: 18, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.lineStrong, justifyContent: "center", backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { color: colors.fg, fontSize: 14, fontWeight: "600" },
  accept: { flexDirection: "row", gap: 12, alignItems: "flex-start", marginTop: 6 },
  errorBox: { flexDirection: "row", gap: 10, alignItems: "center", padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: `${colors.red}55`, backgroundColor: `${colors.red}14` },
  errorText: { color: colors.fg, fontSize: 14.5, fontWeight: "600" },
});
