import { Smartphone } from "lucide-react";
import { StatusScreen } from "@/components/auth/status-screen";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/login/actions";

export default function DriverAppPage() {
  return (
    <StatusScreen icon={<Smartphone />} title="Espace chauffeur" actions={<form action={signOut}><Button variant="secondary" type="submit">Se déconnecter</Button></form>}>
      Les chauffeurs utilisent l&apos;application mobile <span className="text-fg">Rydar Drive</span> (iOS et Android) avec les mêmes identifiants : passez EN LIGNE et recevez vos courses.
    </StatusScreen>
  );
}
