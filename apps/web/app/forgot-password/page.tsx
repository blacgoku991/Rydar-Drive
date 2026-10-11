"use client";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { StatusScreen } from "@/components/auth/status-screen";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { runAction } from "@/lib/run-action";
import { submitWith } from "@/lib/utils";
import { requestPasswordReset } from "./actions";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loading, start] = useTransition();
  return (
    <StatusScreen icon={<MailCheck />} title={sent ? "Vérifiez vos e-mails" : "Mot de passe oublié"}>
      {sent ? (
        <p>Si un compte existe pour cette adresse, un lien de réinitialisation vient d&apos;être envoyé.</p>
      ) : (
        <form
          noValidate
          className="mt-6 space-y-3 text-left"
          // Demande traitée par le serveur (réponse identique, compte existant ou non) : le navigateur n'appelle plus
          // Supabase Auth directement (audit p5, admin-public-2)
          onSubmit={submitWith((f) =>
            start(() =>
              runAction(
                async () => {
                  const res = await requestPasswordReset({ email: String(f.get("email") ?? "") });
                  if (res.ok) {
                    setError(undefined);
                    setSent(true);
                  } else setError(res.error);
                },
                (message) => setError(message),
              ),
            ),
          )}
        >
          <Field label="Adresse e-mail du compte" error={error}>
            <Input name="email" type="email" required autoComplete="email" placeholder="vous@centrale.fr" className="h-11" />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Envoyer le lien</Button>
          <Link href="/login" className="block text-center text-[12.5px] text-fg-subtle hover:text-fg">Retour à la connexion</Link>
        </form>
      )}
    </StatusScreen>
  );
}
