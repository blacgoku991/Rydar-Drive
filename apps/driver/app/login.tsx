import { Ionicons } from "@expo/vector-icons";
import { Redirect } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { frTypo } from "@/components/centrale";
import { RadarPulse } from "@/components/radar";
import { BigButton, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { signIn, type ApiError } from "@/lib/api";
import { colors, radius } from "@/theme";

/** Refus de connexion (codes de /api/auth/driver-login) : titre, icône et couleur du message. */
const DENIED: Record<string, { title: string; icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  BANNED: { title: "Compte banni", icon: "ban", color: colors.red },
  REJECTED: { title: "Candidature refusée", icon: "close-circle", color: colors.red },
  INACTIVE: { title: "Compte inactif", icon: "pause-circle", color: colors.amber },
  ORGANIZATION_SUSPENDED: { title: "Centrale suspendue", icon: "business", color: colors.amber },
  NOT_DRIVER: { title: "Compte non chauffeur", icon: "person-remove", color: colors.amber },
  RATE_LIMITED: { title: "Trop de tentatives", icon: "time", color: colors.amber },
};

export default function Login() {
  const { session, ready, canDrive } = useDriver();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code: string | null } | null>(null);
  // Connecté et état du compte connu : accueil, ou écran d'attente / de blocage
  if (session && ready) return <Redirect href={canDrive ? "/home" : "/account"} />;

  async function submit() {
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
      // Redirection dès que l'état du compte est lu (bouton en attente jusque-là)
    } catch (e) {
      setError({ message: (e as Error).message, code: (e as ApiError).code ?? null });
      setLoading(false);
    }
  }

  const denied = error?.code ? DENIED[error.code] : undefined;
  const tint = denied?.color ?? colors.red;
  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, padding: 24, justifyContent: "space-between" }}>
          <View style={{ alignItems: "center", marginTop: 48 }}>
            <View style={{ width: 220, height: 220, alignItems: "center", justifyContent: "center" }}>
              <RadarPulse size={220} />
              <View style={styles.logo}><View style={styles.logoDot} /></View>
            </View>
            <Text style={styles.brand}>Rydar <Text style={{ color: colors.muted, fontWeight: "400" }}>Drive</Text></Text>
            <Text style={styles.tagline}>Application chauffeur</Text>
          </View>

          <View style={{ gap: 14 }}>
            <View style={styles.field}>
              <Ionicons name="mail-outline" size={18} color={colors.subtle} />
              <TextInput value={email} onChangeText={setEmail} placeholder="E-mail" placeholderTextColor={colors.subtle} autoCapitalize="none" autoComplete="email" keyboardType="email-address" style={styles.input} />
            </View>
            <View style={styles.field}>
              <Ionicons name="lock-closed-outline" size={18} color={colors.subtle} />
              <TextInput value={password} onChangeText={setPassword} placeholder="Mot de passe" placeholderTextColor={colors.subtle} secureTextEntry autoComplete="password" style={styles.input} onSubmitEditing={submit} />
            </View>
            {error && (
              <View style={[styles.errorBox, { borderColor: `${tint}55`, backgroundColor: `${tint}14` }]} accessibilityLiveRegion="assertive" accessibilityRole="alert">
                <Ionicons name={denied?.icon ?? "alert-circle"} size={22} color={tint} />
                <View style={{ flex: 1, gap: 2 }}>
                  {denied && <Text style={[styles.errorTitle, { color: tint }]}>{denied.title}</Text>}
                  <Text style={styles.errorText}>{frTypo(error.message)}</Text>
                </View>
              </View>
            )}
            <BigButton title="Se connecter" onPress={submit} loading={loading} disabled={!email || !password} icon="arrow-forward" />
            <Text style={styles.footer}>Identifiants fournis par votre centrale, ou créés lors de votre inscription par lien.</Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  logo: { width: 76, height: 76, borderRadius: 38, borderWidth: 2, borderColor: colors.brand, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(200,240,60,0.08)" },
  logoDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: colors.brand },
  brand: { color: colors.fg, fontSize: 30, fontWeight: "800", marginTop: 8, letterSpacing: -0.5 },
  tagline: { color: colors.subtle, fontSize: 14, marginTop: 6 },
  field: { flexDirection: "row", alignItems: "center", gap: 10, height: 58, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, paddingHorizontal: 16 },
  input: { flex: 1, color: colors.fg, fontSize: 16 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderRadius: radius.md, borderWidth: 1 },
  errorTitle: { fontSize: 15, fontWeight: "900" },
  errorText: { color: colors.fg, fontSize: 14.5, lineHeight: 20, fontWeight: "600" },
  footer: { color: colors.subtle, fontSize: 12, textAlign: "center", marginTop: 6 },
});
