import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { frTypo } from "@/components/centrale";
import { BigButton, Screen, ScreenHeader } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { deleteAccount, legalUrl } from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { colors, control, radius, space, type, weight } from "@/theme";

const DELETED = [
  "Votre compte de connexion, votre nom, téléphone et e-mail",
  "Vos documents (carte VTC, permis…) et leurs fichiers",
  "Vos positions, appareils et notifications",
  "Vos messages avec la centrale et vos signalements",
];

/**
 * Suppression définitive du compte (App Store 5.1.1(v), Google Play) : ce qui est supprimé, ce qui est conservé
 * sans identité, double confirmation. Accessible depuis le profil et depuis l'écran des comptes en attente,
 * refusés, suspendus ou bannis.
 */
export default function DeleteAccount() {
  const { signOut } = useDriver();
  const [busy, setBusy] = useState(false);
  const policy = legalUrl("suppression-compte");

  async function run() {
    setBusy(true);
    try {
      await deleteAccount();
    } catch (e) {
      setBusy(false);
      Alert.alert("Suppression impossible", frTypo((e as Error).message));
      return;
    }
    // Compte supprimé côté serveur : session locale effacée, retour à la connexion
    await signOut().catch(() => null);
    await supabase.auth.signOut({ scope: "local" }).catch(() => null);
    setBusy(false);
    router.replace("/login");
    Alert.alert("Compte supprimé", "Votre compte Rydar Drive a été supprimé.");
  }

  function confirm() {
    Alert.alert(
      "Supprimer définitivement ?",
      "Votre compte et vos données personnelles seront supprimés. Cette action est irréversible.",
      [
        { text: "Annuler", style: "cancel" },
        { text: "Supprimer", style: "destructive", onPress: () => void run() },
      ],
    );
  }

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }} edges={["top", "bottom"]}>
        <ScreenHeader title="Supprimer mon compte" onBack={() => (router.canGoBack() ? router.back() : router.replace("/login"))} />
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.lead}>
            {frTypo("La suppression est immédiate et définitive. Si une course vous est attribuée, terminez-la ou demandez à votre centrale de la réattribuer avant de supprimer votre compte.")}
          </Text>

          <Text style={styles.section} accessibilityRole="header">Supprimé</Text>
          <View style={styles.group}>
            {DELETED.map((item) => (
              <View key={item} style={styles.row}>
                <Ionicons name="trash-outline" size={20} color={colors.muted} />
                <Text style={styles.rowText}>{item}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.section} accessibilityRole="header">Conservé sans votre identité</Text>
          <Text style={styles.body}>
            {frTypo("Les courses réalisées, gains, commissions et règlements restent enregistrés pour les obligations comptables de la centrale, rattachés à une fiche anonyme.")}
          </Text>

          {policy && (
            <Pressable onPress={() => void Linking.openURL(policy)} accessibilityRole="link" hitSlop={8} style={styles.link}>
              <Text style={styles.linkText}>En savoir plus</Text>
              <Ionicons name="open-outline" size={16} color={colors.muted} />
            </Pressable>
          )}

          <View style={styles.footer}>
            <BigButton title="Supprimer définitivement" variant="danger" icon="trash-outline" height={control.md} loading={busy} disabled={busy} onPress={confirm} />
            <BigButton title="Annuler" variant="ghost" height={control.md} disabled={busy} onPress={() => (router.canGoBack() ? router.back() : router.replace("/login"))} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.lg, gap: space.md },
  lead: { color: colors.fg, fontSize: type.callout, lineHeight: 22 },
  section: { color: colors.muted, fontSize: type.subhead, fontWeight: weight.semibold, marginTop: space.sm, marginLeft: space.xs },
  group: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingVertical: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  rowText: { flex: 1, color: colors.fg, fontSize: type.subhead },
  body: { color: colors.muted, fontSize: type.subhead, lineHeight: 20, marginHorizontal: space.xs },
  link: { flexDirection: "row", alignItems: "center", gap: space.xs, alignSelf: "flex-start", minHeight: 48, marginLeft: space.xs },
  linkText: { color: colors.fg, fontSize: type.subhead, fontWeight: weight.medium, textDecorationLine: "underline" },
  footer: { marginTop: "auto", paddingTop: space.xl, gap: space.sm },
});
