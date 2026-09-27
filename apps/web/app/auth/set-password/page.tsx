"use client";
import { NEW_PASSWORD_MIN } from "@rydar/shared";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CheckCircle2, KeyRound, Smartphone, UserRound } from "lucide-react";
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

/** Compte visé par un jeton d'accès (charge utile du JWT, non vérifiée : sert seulement à prévenir l'utilisateur). */
function tokenAccount(token: string): { sub: string | null; email: string | null } {
  try {
    const part = token.split(".")[1] ?? "";
    const json = decodeURIComponent(
      Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")))
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
    );
    const claims = JSON.parse(json) as { sub?: unknown; email?: unknown };
    return { sub: typeof claims.sub === "string" ? claims.sub : null, email: typeof claims.email === "string" ? claims.email : null };
  } catch {
    return { sub: null, email: null };
  }
}

type AcceptResult = { ok: boolean; code: string; activated?: number; message?: string };

/**
 * Définition du mot de passe après invitation ou réinitialisation.
 * `?app=driver` : lien « Mot de passe oublié » de l'application chauffeur (flux implicite, jetons dans le
 * fragment). Client Supabase ISOLÉ, sans cookie : la session de réinitialisation ne vit que dans cette page
 * (jamais celle d'un compte déjà connecté au dashboard dans ce navigateur), et elle est révoquée à la fin.
 * Tableau de bord : le lien ne remplace JAMAIS en silence la session d'un autre compte déjà ouverte dans ce navigateur
 * (confirmation explicite) ; l'adresse du compte concerné est affichée. Mot de passe enregistré → les invitations en
 * attente du compte sont activées (accept_member_invitations : session ouverte par ce lien seulement).
 */
export default function SetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [forDriver, setForDriver] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkInvalid, setLinkInvalid] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ current: string; target: string } | null>(null);
  const driverClient = useRef<SupabaseClient | null>(null);
  const pendingTokens = useRef<{ access_token: string; refresh_token: string } | null>(null);
  const started = useRef(false);

  /** Session du lien installée dans le navigateur (tableau de bord), adresse du compte affichée. */
  const installLinkSession = async (tokens: { access_token: string; refresh_token: string } | null) => {
    const supabase = getBrowserClient();
    if (tokens && (await supabase.auth.setSession(tokens)).error) {
      setLinkInvalid("Lien invalide ou expiré. Demandez une nouvelle invitation.");
      return;
    }
    const { data } = await supabase.auth.getSession();
    if (!data.session) setLinkInvalid("Lien invalide ou expiré. Demandez une nouvelle invitation.");
    else setAccount(data.session.user.email ?? null);
  };

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
      } else if (linkError) {
        setLinkInvalid("Lien invalide ou expiré. Demandez une nouvelle invitation.");
      } else {
        const tokens = access_token && refresh_token ? { access_token, refresh_token } : null;
        // Un autre compte est déjà connecté dans ce navigateur : on ne le remplace pas sans le dire
        const { data: current } = await getBrowserClient().auth.getSession();
        const target = tokens ? tokenAccount(tokens.access_token) : null;
        if (tokens && current.session && target?.sub && current.session.user.id !== target.sub) {
          pendingTokens.current = tokens;
          setConflict({ current: current.session.user.email ?? "un autre compte", target: target.email ?? "un autre compte" });
        } else {
          await installLinkSession(tokens);
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

  if (conflict) {
    return (
      <StatusScreen
        icon={<UserRound />}
        title="Changer de compte ?"
        actions={
          <>
            <Button variant="secondary" onClick={() => router.replace("/dashboard")}>
              Annuler
            </Button>
            <Button
              variant="primary"
              loading={loading}
              onClick={async () => {
                setLoading(true);
                // Session de l'autre compte fermée sur CE navigateur seulement
                await getBrowserClient().auth.signOut({ scope: "local" }).catch(() => undefined);
                await installLinkSession(pendingTokens.current);
                pendingTokens.current = null;
                setConflict(null);
                setLoading(false);
              }}
            >
              Changer de compte
            </Button>
          </>
        }
      >
        <p className="[overflow-wrap:anywhere]">
          Vous êtes connecté avec <span className="font-medium text-fg">{conflict.current}</span>. Ce lien concerne le compte{" "}
          <span className="font-medium text-fg">{conflict.target}</span> : changer de compte ferme votre session actuelle sur ce navigateur.
        </p>
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
            // Tableau de bord : même mot de passe qu'avant = déjà le sien, on continue (activation des invitations)
            if (err && !(err.code === "same_password" && !forDriver)) {
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
            // Invitations en attente (accès à une centrale) : activées par cette session ouverte depuis le lien
            const { data: accepted, error: acceptError } = await getBrowserClient().rpc("accept_member_invitations");
            const res = (accepted ?? null) as AcceptResult | null;
            if (acceptError || (res && !res.ok && res.code === "EMAIL_PROOF_REQUIRED")) {
              setLoading(false);
              return setError(
                acceptError
                  ? "Mot de passe enregistré, mais l'activation de votre accès a échoué : demandez à la centrale de renvoyer l'invitation."
                  : "Mot de passe enregistré. Pour activer votre accès à la centrale, ouvrez le lien reçu par e-mail.",
              );
            }
            // Accès activé : seul un jeton émis après l'activation l'ouvre (migration 005300) → session rafraîchie
            if (res?.code === "ACTIVATED") await getBrowserClient().auth.refreshSession().catch(() => undefined);
            router.replace("/dashboard");
            router.refresh();
          }}
        >
          {!forDriver && account && (
            <p className="rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[13px] text-fg-muted [overflow-wrap:anywhere]">
              Compte : <span className="font-medium text-fg">{account}</span>
            </p>
          )}
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
