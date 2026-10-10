import type { Metadata } from "next";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/layout/page-header";
import { Callout } from "@/components/ui/callout";
import { Disclosure } from "@/components/ui/disclosure";
import { NewTabHint } from "@/components/ui/new-tab";
import { requireSuperAdmin } from "@/lib/auth";
import { getLegalInfo } from "@/lib/legal";
import { plural } from "@/lib/wording";
import { DeletionQueueList, DriverDeletionSearch } from "./deletion-tools";
import type { DeletionQueue } from "./types";

export const metadata: Metadata = { title: "Suppressions de comptes" };
export const dynamic = "force-dynamic";

const code = "mono rounded bg-white/[0.05] px-1 py-px text-[12px] text-fg";

/**
 * Super admin : demandes de suppression de compte reçues sans l'application (contact « données personnelles »
 * affiché sur /suppression-compte, à traiter sous 30 jours) et file des suppressions en cours ou en échec.
 * Les réglages du serveur à vérifier sont dans « Détails techniques », pour le technicien (docs/REFONTE-PANELS.md, R6).
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
        title="Suppressions de comptes"
        description="Demandes de suppression de compte d'un chauffeur, à traiter sous 30 jours, et suivi des suppressions."
      />
      <PageBody className="space-y-6">
        {!legal.privacyEmail && (
          <Callout tone="warning" title="Aucune adresse de contact pour les suppressions">
            La page publique{" "}
            <Link href="/suppression-compte" prefetch={false} target="_blank" className="text-fg underline underline-offset-2">
              Supprimer son compte
              <NewTabHint />
            </Link>{" "}
            ne peut pas indiquer où écrire. Renseignez le contact «{"\u00a0"}données personnelles{"\u00a0"}» dans{" "}
            <Link href="/admin/legal" prefetch={false} className="text-fg underline underline-offset-2">
              Informations légales
            </Link>
            .
          </Callout>
        )}
        {error && <Callout tone="danger" title="Lecture impossible, réessayez dans un instant." />}
        {queue.stalled > 0 && (
          <Callout tone="danger" title={`${plural(queue.stalled, "suppression attend", "suppressions attendent")} depuis plus de 30${"\u00a0"}min`}>
            <p>
              Le serveur ne termine plus les suppressions (fichiers, comptes de connexion). En attendant, «{"\u00a0"}Réessayer{"\u00a0"}» les
              termine depuis cette page.
            </p>
            <Disclosure title="Détails techniques (à transmettre à votre technicien)" summaryClassName="text-[13px] text-fg-muted hover:text-fg">
              <p className="pb-1 text-[12.5px] leading-relaxed">
                Le service <code className={code}>worker</code> ne reprend pas la file des suppressions. Vérifiez qu&apos;il reçoit{" "}
                <code className={code}>SUPABASE_URL</code> et <code className={code}>SUPABASE_SERVICE_ROLE_KEY</code> (son journal indique
                alors «{"\u00a0"}account deletions cannot be completed{"\u00a0"}»).
              </p>
            </Disclosure>
          </Callout>
        )}
        <DriverDeletionSearch />
        <DeletionQueueList queue={queue} />
      </PageBody>
    </>
  );
}
