import { Redirect } from "expo-router";
import { useDriver } from "@/hooks/driver-context";

export default function Index() {
  const { ready, session, canDrive } = useDriver();
  if (!ready) return null;
  if (!session) return <Redirect href="/login" />;
  // Candidature en attente, compte refusé / banni / suspendu : écran d'état du compte
  return <Redirect href={canDrive ? "/home" : "/account"} />;
}
