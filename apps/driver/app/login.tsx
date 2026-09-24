import { Ionicons } from "@expo/vector-icons";
import { Redirect } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { RadarPulse } from "@/components/radar";
import { BigButton, Screen } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { signIn } from "@/lib/api";
import { colors, radius } from "@/theme";

export default function Login() {
  const { session } = useDriver();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (session) return <Redirect href="/home" />;

  async function submit() {
    setError(null);
    setLoading(true);
    try {
      await signIn(email, password);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

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
            {error && <Text style={styles.error}>{error}</Text>}
            <BigButton title="Se connecter" onPress={submit} loading={loading} disabled={!email || !password} icon="arrow-forward" />
            <Text style={styles.footer}>Identifiants fournis par votre centrale.</Text>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  logo: { width: 76, height: 76, borderRadius: 38, borderWidth: 2, borderColor: colors.brand, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(200,240,60,0.08)" },
  logoDot: { width: 18, height: 18, borderRadius: 9, backgroundColor: colors.brand, shadowColor: colors.brand, shadowOpacity: 1, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
  brand: { color: colors.fg, fontSize: 30, fontWeight: "800", marginTop: 8, letterSpacing: -0.5 },
  tagline: { color: colors.subtle, fontSize: 13, marginTop: 6, letterSpacing: 2, textTransform: "uppercase" },
  field: { flexDirection: "row", alignItems: "center", gap: 10, height: 58, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, paddingHorizontal: 16 },
  input: { flex: 1, color: colors.fg, fontSize: 16 },
  error: { color: colors.red, fontSize: 14, textAlign: "center" },
  footer: { color: colors.subtle, fontSize: 12, textAlign: "center", marginTop: 6 },
});
