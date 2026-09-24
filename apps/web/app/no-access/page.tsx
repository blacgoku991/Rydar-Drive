import { Lock } from "lucide-react";
import { StatusScreen } from "@/components/auth/status-screen";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/login/actions";

export default function NoAccessPage() {
  return (
    <StatusScreen icon={<Lock />} title="Aucun espace associé" actions={<form action={signOut}><Button variant="secondary" type="submit">Se déconnecter</Button></form>}>
      Votre compte n&apos;est rattaché à aucune centrale active. Demandez une invitation à l&apos;administrateur de votre centrale.
    </StatusScreen>
  );
}
