// Conditions des courses du réseau partagé (document « network_driver », §7.3) : l'essentiel, le lien vers le texte
// complet, « J'accepte » (ou « Activer » quand la version en vigueur est déjà acceptée). Ouvert depuis le profil, ou
// proposé une fois à l'accueil quand l'organisation du chauffeur reçoit le réseau, puis à chaque nouvelle version
// (use-network-terms-prompt). Tout chauffeur accepte et règle lui-même. Preuve côté serveur : driver_set_network →
// legal_acceptances (network_driver, source « app »).
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { announce, Notice } from "@/components/auth";
import { frTypo } from "@/components/centrale";
import { BigButton, hapticResult, Screen, ScreenHeader } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { api, ApiError, networkTermsUrl } from "@/lib/api";
import { networkTermsContent } from "@/lib/network";
import { colors, control, space, type, weight } from "@/theme";

export default function NetworkTerms() {
  const { network, applyNetwork, refreshNetwork } = useDriver();
  const [loading, setLoading] = useState(network == null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const content = networkTermsContent(network);
  const fullUrl = networkTermsUrl();

  // Ouvert sans état réseau connu (notification, retour après coupure) : relu une fois
  useEffect(() => {
    if (network) return;
    let alive = true;
    void refreshNetwork().finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace("/home");
  }

  async function accept() {
    if (!network || busy) return;
    setBusy(true);
    setError(null);
    try {
      const state = await api.setNetwork(true, content.version);
      applyNetwork(state);
      hapticResult(true);
      announce("Courses du réseau partagé activées");
      close();
    } catch (e) {
      hapticResult(false);
      setError(frTypo((e as Error).message || "Activation impossible. Réessayez."));
      // Conditions changées entre-temps : nouveau texte relu
      if (e instanceof ApiError && e.code === "NETWORK_TERMS_OUTDATED") void refreshNetwork();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <SafeAreaView edges={["top", "bottom"]} style={styles.root}>
        <ScreenHeader title="Réseau partagé" onBack={close} />
        {!network ? (
          <View style={styles.center}>
            {loading ? (
              <ActivityIndicator color={colors.muted} accessibilityLabel="Chargement" />
            ) : (
              <>
                <Text style={styles.lead}>Le réseau partagé n'est pas disponible pour le moment.</Text>
                <BigButton title="Fermer" variant="secondary" height={control.md} onPress={close} style={styles.stretch} />
              </>
            )}
          </View>
        ) : (
          <>
            <ScrollView contentContainerStyle={styles.content} bounces={false} overScrollMode="never">
              <View style={styles.head}>
                <Text style={styles.title} accessibilityRole="header">{content.title}</Text>
                <Text style={styles.lead}>{content.lead}</Text>
              </View>
              <View style={styles.points}>
                {content.points.map((point) => (
                  <View key={point} style={styles.point}>
                    <Text style={styles.bullet} accessibilityElementsHidden importantForAccessibility="no">•</Text>
                    <Text style={styles.pointText}>{point}</Text>
                  </View>
                ))}
              </View>
              {fullUrl && (
                <Pressable
                  onPress={() => void Linking.openURL(fullUrl).catch(() => null)}
                  style={({ pressed }) => [styles.link, pressed && styles.pressed]}
                  accessibilityRole="link"
                  accessibilityHint="S'ouvre dans le navigateur"
                >
                  <Text style={styles.linkText}>Lire les conditions complètes</Text>
                  <Ionicons name="open-outline" size={18} color={colors.fg} />
                </Pressable>
              )}
            </ScrollView>
            <View style={styles.footer}>
              {content.primary === "J'accepte" && <Text style={styles.note}>{content.note}</Text>}
              {error && <Notice tone="error" message={error} />}
              {content.primary ? (
                <BigButton title={content.primary} icon="checkmark" height={control.lg} loading={busy} onPress={() => void accept()} />
              ) : null}
              <BigButton title={content.primary ? "Plus tard" : "Fermer"} variant={content.primary ? "ghost" : "secondary"} height={control.md} disabled={busy} onPress={close} />
            </View>
          </>
        )}
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.lg, paddingHorizontal: space.xl },
  stretch: { alignSelf: "stretch" },
  content: { flexGrow: 1, paddingHorizontal: space.xl, paddingTop: space.md, paddingBottom: space.lg, gap: space.xl },
  head: { gap: space.sm },
  title: { color: colors.fg, fontSize: type.title2, fontWeight: weight.bold, letterSpacing: -0.3 },
  lead: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  points: { gap: space.md },
  point: { flexDirection: "row", gap: space.sm },
  bullet: { color: colors.muted, fontSize: type.body, lineHeight: 21 },
  pointText: { flex: 1, color: colors.fg, fontSize: type.body, lineHeight: 21 },
  link: { flexDirection: "row", alignItems: "center", gap: space.sm, alignSelf: "flex-start", minHeight: control.sm },
  pressed: { opacity: 0.6 },
  linkText: { color: colors.fg, fontSize: type.body, fontWeight: weight.medium, textDecorationLine: "underline" },
  footer: {
    paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.sm, gap: space.md, borderTopWidth: 1, borderColor: colors.line,
    backgroundColor: colors.bg,
  },
  note: { color: colors.muted, fontSize: type.subhead, lineHeight: 20 },
});
