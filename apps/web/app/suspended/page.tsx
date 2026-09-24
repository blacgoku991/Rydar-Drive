import { PauseCircle } from "lucide-react";
import { StatusScreen } from "@/components/auth/status-screen";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/login/actions";

export default function SuspendedPage() {
  return (
    <StatusScreen icon={<PauseCircle />} title="Compte suspendu" actions={<form action={signOut}><Button variant="secondary" type="submit">Se déconnecter</Button></form>}>
      L&apos;accès de votre centrale à Rydar Drive est temporairement suspendu. Contactez l&apos;équipe Rydar pour le réactiver.
    </StatusScreen>
  );
}
