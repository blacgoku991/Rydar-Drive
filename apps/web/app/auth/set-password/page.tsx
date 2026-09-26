"use client";
import { NEW_PASSWORD_MIN } from "@rydar/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CheckCircle2, KeyRound, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StatusScreen } from "@/components/auth/status-screen";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { env } from "@/lib/env";
import { getBrowserClient } from "@/lib/supabase/client";

function OpenAppButton() {
  return (
    <Button asChild variant="primary" size="lg">
      <a href="rydardrive://login">
        <Smartphone /> Ouvrir l&apos;application
      </a>
    </Button>
  );
}

/**
 * Définition du mot de passe après invitation ou réinitialisation.
 * `?app=driver` : lien « Mot de passe oublié » de l'application chauffeur (flux implicite, jetons dans le
 * fragment). Client Supabase ISOLÉ, sans cookie : la session de réinitialisation ne vit que dans cette page
 * (jamais celle d'un compte déjà connecté au dashboard dans ce navigateur), et elle est révoquée à la fin.
 */
export default function SetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [forDriver, setForDriver] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInvalid, setLinkInvalid] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const driverClient = useRef<SupabaseClient | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Une seule lecture des jetons (le fragment est effacé aussitôt ; effets doublés en développement)
    if (started.current) return;
    started.current = true;
    const driver = new URLSearchParams(window.location.search).get("app") === "driver";
    setForDriver(driver);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    // Lien expiré ou déjà utilisé : Supabase renvoie #error=…&error_code=otp_expired
    const linkError = hash.get("error_code") ?? hash.get("error");
    window.history.replaceState(null, "", `${window.location.pathname}${driver ? "?app=driver" : ""}`);
    (async () => {
      if (driver) {
        const client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "rydar-driver-reset" },
        });
        driverClient.current = client;
        const ok = !linkError && !!access_token && !!refresh_token && !(await client.auth.setSession({ access_token, refresh_token })).error;
        if (!ok) setLinkInvalid("Ce lien a expiré ou a déjà servi. Demandez-en un nouveau dans l'application : « Mot de passe oublié ? ».");
      } else {
        const supabase = getBrowserClient();
        if (linkError) setLinkInvalid("Lien invalide ou expiré. Demandez une nouvelle invitation.");
        else {
          if (access_token && refresh_token) await supabase.auth.setSession({ access_token, refresh_token });
          const { data } = await supabase.auth.getSession();
          if (!data.session) setLinkInvalid("Lien invalide ou expiré. Demandez une nouvelle invitation.");
        }
      }
      setReady(true);
    })();
  }, []);

  if (done) {
    return (
      <StatusScreen icon={<CheckCircle2 className="text-brand" />} title="Mot de passe modifié" actions={<OpenAppButton />}>
        <p>Retournez dans l&apos;application Rydar Drive et connectez-vous avec votre nouveau mot de passe.</p>
      </StatusScreen>
    );
  }

  if (ready && linkInvalid) {
    return (
      <StatusScreen icon={<KeyRound />} title="Lien expiré" actions={forDriver ? <OpenAppButton /> : undefined}>
        <p>{linkInvalid}</p>
      </StatusScreen>
    );
  }

  return (
    <StatusScreen icon={<KeyRound />} title={forDriver ? "Nouveau mot de passe" : "Choisissez votre mot de passe"}>
      {!ready ? (
        <p>Vérification du lien…</p>
      ) : (
        <form
          noValidate
          className="mt-6 space-y-3 text-left"
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            const password = String(data.get("password") ?? "");
            if (password.length < NEW_PASSWORD_MIN) return setError(`Mot de passe trop court : ${NEW_PASSWORD_MIN} caractères minimum.`);
            if (password !== String(data.get("confirm") ?? "")) return setError("Les deux mots de passe ne correspondent pas.");
            setError(null);
            setLoading(true);
            const supabase = forDriver ? driverClient.current : getBrowserClient();
            const { error: err } = supabase ? await supabase.auth.updateUser({ password }) : { error: { code: "no_session" } };
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
              // Le chauffeur se connecte dans l'app : la session de réinitialisation est révoquée
              await driverClient.current?.auth.signOut({ scope: "local" }).catch(() => undefined);
              setLoading(false);
              return setDone(true);
            }
            router.replace("/dashboard");
          }}
        >
          <div className="space-y-1.5">
            <Input name="password" type="password" required placeholder="Nouveau mot de passe" className="h-12 text-base" autoComplete="new-password" aria-label="Nouveau mot de passe" aria-describedby="password-rule" />
            <p id="password-rule" className="px-1 text-[13px] text-fg-muted">{NEW_PASSWORD_MIN} caractères minimum.</p>
          </div>
          <Input name="confirm" type="password" required placeholder="Confirmez le mot de passe" className="h-12 text-base" autoComplete="new-password" aria-label="Confirmation du mot de passe" />
          {error && <p className="text-[13px] text-red" role="alert">{error}</p>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>Enregistrer</Button>
        </form>
      )}
    </StatusScreen>
  );
}
