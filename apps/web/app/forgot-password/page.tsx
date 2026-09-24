"use client";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { StatusScreen } from "@/components/auth/status-screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getBrowserClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  return (
    <StatusScreen icon={<MailCheck />} title={sent ? "Vérifiez vos e-mails" : "Mot de passe oublié"}>
      {sent ? (
        <p>Si un compte existe pour cette adresse, un lien de réinitialisation vient d&apos;être envoyé.</p>
      ) : (
        <form
          className="mt-6 space-y-3 text-left"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            const email = String(new FormData(e.currentTarget).get("email") ?? "");
            await getBrowserClient().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/auth/callback?next=/auth/set-password` });
            setLoading(false);
            setSent(true);
          }}
        >
          <Input name="email" type="email" required placeholder="vous@centrale.fr" className="h-11" />
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Envoyer le lien</Button>
          <Link href="/login" className="block text-center text-[12.5px] text-fg-subtle hover:text-fg">Retour à la connexion</Link>
        </form>
      )}
    </StatusScreen>
  );
}
