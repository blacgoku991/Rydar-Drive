// Documents du chauffeur : statut, échéance, motif de refus ; mise à jour par photo (driver_submit_document).
// Composants partagés avec l'écran d'attente du candidat : src/components/documents.tsx.
import { useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { buildDocEntries, DocCard, DocumentsSummary, UploadSheet, useDriverDocuments, type DocEntry } from "@/components/documents";
import { Screen, ScreenHeader, useFlash } from "@/components/ui";
import { useDriver } from "@/hooks/driver-context";
import { colors } from "@/theme";

export default function Documents() {
  const { home } = useDriver();
  const insets = useSafeAreaInsets();
  const flash = useFlash(insets.top + 64);
  const { data, error, load } = useDriverDocuments();
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<DocEntry | null>(null);
  const entries = useMemo(() => buildDocEntries(data), [data]);

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
  errorText: { color: colors.red, fontSize: 15, textAlign: "center" },
  footnote: { color: colors.subtle, fontSize: 12.5, textAlign: "center", marginTop: 6, paddingHorizontal: 20 },
});
