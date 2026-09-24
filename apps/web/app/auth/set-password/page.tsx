"use client";
import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StatusScreen } from "@/components/auth/status-screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getBrowserClient } from "@/lib/supabase/client";

/** Définition du mot de passe après invitation ou réinitialisation. */
export default function SetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const supabase = getBrowserClient();
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    (async () => {
      if (access_token && refresh_token) await supabase.auth.setSession({ access_token, refresh_token });
      const { data } = await supabase.auth.getSession();
      if (!data.session) setError("Lien invalide ou expiré. Demandez une nouvelle invitation.");
      setReady(true);
      window.history.replaceState(null, "", window.location.pathname);
    })();
  }, []);

  return (
    <StatusScreen icon={<KeyRound />} title="Choisissez votre mot de passe">
      {!ready ? (
        <p>Vérification du lien…</p>
      ) : (
        <form
          className="mt-6 space-y-3 text-left"
          onSubmit={async (e) => {
            e.preventDefault();
            const password = String(new FormData(e.currentTarget).get("password") ?? "");
            if (password.length < 10) return setError("10 caractères minimum.");
            setLoading(true);
            const { error: err } = await getBrowserClient().auth.updateUser({ password });
            setLoading(false);
            if (err) return setError("Impossible d'enregistrer le mot de passe.");
            router.replace("/dashboard");
          }}
        >
          <Input name="password" type="password" required minLength={10} placeholder="10 caractères minimum" className="h-11" autoComplete="new-password" />
          {error && <p className="text-[13px] text-red">{error}</p>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Enregistrer</Button>
        </form>
      )}
    </StatusScreen>
  );
}
