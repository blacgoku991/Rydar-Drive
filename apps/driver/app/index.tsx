import { Redirect } from "expo-router";
import { useDriver } from "@/hooks/driver-context";

export default function Index() {
  const { ready, session } = useDriver();
  if (!ready) return null;
  return <Redirect href={session ? "/home" : "/login"} />;
}
