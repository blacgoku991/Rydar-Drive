// Documents du chauffeur : statut, échéance, motif de refus ; mise à jour par photo (driver_submit_document).
// Composants partagés avec l'écran d'attente du candidat : src/components/documents.tsx.
import { useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { frTypo } from "@/components/centrale";
import { buildDocEntries, DocCard, DocumentsSummary, UploadSheet, useDriverDocuments, type DocEntry } from "@/components/documents";
import { BigButton, Screen, ScreenHeader, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { colors, control, space, type } from "@/theme";

export default function Documents() {
  const { home } = useDriver();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 64);
  const { data, error, load } = useDriverDocuments();
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [editing, setEditing] = useState<DocEntry | null>(null);
  const entries = useMemo(() => buildDocEntries(data), [data]);

  return (
    <Screen>
      <SafeAreaView edges={["top"]} style={styles.fill}>
        <ScreenHeader title="Mes documents" />
        <ScrollView
          contentContainerStyle={styles.scroll}
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
            <View style={styles.empty}>
              {error ? (
                <>
                  <Text style={styles.errorText} accessibilityRole="alert">
                    {frTypo(error)}
                  </Text>
                  <BigButton
                    title="Réessayer"
                    icon="refresh-outline"
                    variant="secondary"
                    height={control.md}
                    loading={retrying}
                    onPress={async () => {
                      setRetrying(true);
                      await load();
                      setRetrying(false);
                    }}
                    style={styles.retry}
                  />
                </>
              ) : (
                <ActivityIndicator color={colors.muted} accessibilityLabel="Chargement des documents" />
              )}
            </View>
          ) : (
            <>
              <DocumentsSummary data={data} entries={entries} />
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: { padding: space.lg, gap: space.md, paddingBottom: space.xxl + 16 },
  empty: { paddingVertical: 80, alignItems: "center", gap: space.lg },
  errorText: { color: colors.fg, fontSize: type.body, lineHeight: 21, textAlign: "center", paddingHorizontal: space.lg },
  retry: { alignSelf: "stretch" },
  footnote: { color: colors.muted, fontSize: type.footnote, lineHeight: 18, textAlign: "center", marginTop: space.sm, paddingHorizontal: space.xl },
});
