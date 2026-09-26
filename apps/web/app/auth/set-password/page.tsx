"use client";
import { NEW_PASSWORD_MIN } from "@rydar/shared";
import { CheckCircle2, KeyRound, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StatusScreen } from "@/components/auth/status-screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getBrowserClient } from "@/lib/supabase/client";

/**
 * Définition du mot de passe après invitation ou réinitialisation.
 * `?app=driver` : lien « Mot de passe oublié » de l'application chauffeur (flux implicite, jetons dans le
 * fragment) ; à la fin, la session du navigateur est fermée et le chauffeur retourne dans l'app.
 */
export default function SetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [forDriver, setForDriver] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInvalid, setLinkInvalid] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const supabase = getBrowserClient();
    const driver = new URLSearchParams(window.location.search).get("app") === "driver";
    setForDriver(driver);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    // Lien expiré ou déjà utilisé : Supabase renvoie #error=…&error_code=otp_expired
    const linkError = hash.get("error_code") ?? hash.get("error");
    const invalid = driver
      ? "Lien invalide ou expiré. Demandez un nouveau lien dans l'application (« Mot de passe oublié ? »)."
      : "Lien invalide ou expiré. Demandez une nouvelle invitation.";
    (async () => {
      if (linkError) setLinkInvalid(invalid);
      else {
        if (access_token && refresh_token) await supabase.auth.setSession({ access_token, refresh_token });
        const { data } = await supabase.auth.getSession();
        if (!data.session) setLinkInvalid(invalid);
      }
      setReady(true);
      window.history.replaceState(null, "", `${window.location.pathname}${driver ? "?app=driver" : ""}`);
    })();
  }, []);

  if (done) {
    return (
      <StatusScreen
        icon={<CheckCircle2 className="text-brand" />}
        title="Mot de passe modifié"
        actions={
          <Button asChild variant="primary" size="lg">
            <a href="rydardrive://login">
              <Smartphone /> Ouvrir l&apos;application
            </a>
          </Button>
        }
      >
        <p>Retournez dans l&apos;application Rydar Drive et connectez-vous avec votre nouveau mot de passe.</p>
      </StatusScreen>
    );
  }

  return (
    <StatusScreen icon={<KeyRound />} title={forDriver ? "Nouveau mot de passe" : "Choisissez votre mot de passe"}>
      {!ready ? (
        <p>Vérification du lien…</p>
      ) : linkInvalid ? (
        <p className="text-red">{linkInvalid}</p>
      ) : (
        <form
          className="mt-6 space-y-3 text-left"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const password = String(data.get("password") ?? "");
            if (password.length < NEW_PASSWORD_MIN) return setError(`${NEW_PASSWORD_MIN} caractères minimum.`);
            if (password !== String(data.get("confirm") ?? "")) return setError("Les deux mots de passe ne correspondent pas.");
            setError(null);
            setLoading(true);
            const supabase = getBrowserClient();
            const { error: err } = await supabase.auth.updateUser({ password });
            if (err) {
              setLoading(false);
              return setError(
                err.code === "same_password"
                  ? "Choisissez un mot de passe différent de l'ancien."
                  : err.code === "weak_password"
                    ? "Mot de passe trop simple : mélangez lettres, chiffres et symboles."
                    : "Impossible d'enregistrer le mot de passe. Le lien a peut-être expiré.",
              );
            }
            if (forDriver) {
              // Le chauffeur se connecte dans l'app : pas de session laissée ouverte dans le navigateur
              await supabase.auth.signOut({ scope: "local" });
              setLoading(false);
              return setDone(true);
            }
            router.replace("/dashboard");
          }}
        >
          <Input name="password" type="password" required minLength={NEW_PASSWORD_MIN} placeholder={`Nouveau mot de passe (${NEW_PASSWORD_MIN} caractères minimum)`} className="h-11" autoComplete="new-password" aria-label="Nouveau mot de passe" />
          <Input name="confirm" type="password" required minLength={NEW_PASSWORD_MIN} placeholder="Confirmez le mot de passe" className="h-11" autoComplete="new-password" aria-label="Confirmation du mot de passe" />
          {error && <p className="text-[13px] text-red" role="alert">{error}</p>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Enregistrer</Button>
        </form>
      )}
    </StatusScreen>
  );
}
