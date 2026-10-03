import { AlertTriangle } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { requireSuperAdmin } from "@/lib/auth";
import { getLegalInfo } from "@/lib/legal";
import { DeletionQueueList, DriverDeletionSearch } from "./deletion-tools";
import type { DeletionQueue } from "./types";
import { NewTabHint } from "@/components/ui/new-tab";

export const metadata: Metadata = { title: "Suppressions de comptes" };
export const dynamic = "force-dynamic";

/**
 * Super admin : demandes de suppression de compte reçues sans l'application (contact « données personnelles »
 * affiché sur /suppression-compte, à traiter sous 30 jours) et file des suppressions en cours ou en échec.
 */
export default async function AdminDeletionsPage() {
  const session = await requireSuperAdmin();
  const [{ data, error }, legal] = await Promise.all([
    session.supabase.rpc("admin_account_deletions", { p_limit: 200 }),
    getLegalInfo(),
  ]);
  const queue = (data ?? { items: [], pending: 0, failed: 0, stalled: 0 }) as DeletionQueue;

  return (
    <>
      <PageHeader
        eyebrow="Supervision"
        title="Suppressions de comptes"
        description="Demandes de suppression reçues par e-mail (chauffeur sans l'application, compte bloqué) : à traiter sous 30 jours. La suppression depuis l'application passe par la même file."
      />
      <PageBody className="space-y-6">
        {!legal.privacyEmail && (
          <p className="flex items-start gap-2 rounded-xl border border-amber/25 bg-amber/[0.06] px-4 py-3 text-[13px] text-fg-muted">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber" />
            <span>
              Aucune adresse de contact n&apos;est renseignée : la page publique{" "}
              <Link href="/suppression-compte" target="_blank" className="text-fg underline underline-offset-2">
                Supprimer son compte
                <NewTabHint />
              </Link>{" "}
              ne peut pas indiquer où écrire. Renseignez le contact « données personnelles » dans{" "}
              <Link href="/admin/legal" className="text-fg underline underline-offset-2">
                Informations légales
              </Link>
              .
            </span>
          </p>
        )}
        {error && (
          <p className="rounded-xl border border-red/25 bg-red/[0.06] px-4 py-3 text-[13px] text-fg-muted">
            File de suppression illisible pour le moment : rechargez la page.
          </p>
        )}
        {queue.stalled > 0 && (
          <p className="flex items-start gap-2 rounded-xl border border-red/25 bg-red/[0.06] px-4 py-3 text-[13px] text-fg-muted">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red" />
            <span>
              {queue.stalled > 1 ? `${queue.stalled} suppressions attendent` : "Une suppression attend"} depuis plus de 30 min : le
              worker ne reprend pas la file (fichiers, comptes de connexion). Vérifiez que son service reçoit{" "}
              <span className="font-mono text-fg">SUPABASE_URL</span> et{" "}
              <span className="font-mono text-fg">SUPABASE_SERVICE_ROLE_KEY</span> (journal du worker : « account deletions
              cannot be completed »). En attendant, « Réessayer » termine la suppression depuis ce tableau de bord.
            </span>
          </p>
        )}
        <DriverDeletionSearch />
        <DeletionQueueList queue={queue} />
      </PageBody>
    </>
  );
}
