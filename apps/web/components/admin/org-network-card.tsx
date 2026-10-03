// Super admin — fiche organisation : carte « Réseau partagé » (état des deux sens, validation, convention, suspension)
// avec un lien vers /admin/reseau. Affichée quand le réseau est ouvert ou que l'organisation y a déjà participé.
import { formatDate, formatPrice, type NetworkMembership } from "@rydar/shared";
import { ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { APPROVAL_META, membershipApproval } from "@/components/network-share/admin";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[12.5px]">
      <span className="shrink-0 text-fg-subtle">{label}</span>
      <span className="min-w-0 text-right text-fg [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

export function OrgNetworkCard({
  orgId,
  membership: m,
  enabled,
  timeZone,
  currency = "EUR",
}: {
  orgId: string;
  membership: NetworkMembership | null;
  /** Interrupteur de la plateforme */
  enabled: boolean;
  timeZone: string;
  currency?: string;
}) {
  const approval = membershipApproval(m);
  const meta = APPROVAL_META[approval];
  return (
    <Card>
      <CardHeader
        icon={<ArrowLeftRight className="text-violet" />}
        title="Réseau partagé"
        description={enabled ? "Courses non prises partagées entre organisations validées." : "Réseau fermé pour toute la plateforme (réglages conservés)."}
        action={<Badge tone={meta.tone}>{meta.label}</Badge>}
      />
      <CardBody className="space-y-3">
        {!m ? (
          <p className="text-[13px] text-fg-muted">Aucune demande de participation.</p>
        ) : (
          <div className="divide-y divide-line">
            <Row label="Partager ses courses non prises">{m.share_out ? "Demandé" : "Non"}</Row>
            <Row label="Recevoir les courses du réseau">{m.share_in ? "Demandé" : "Non"}</Row>
            <Row label="Validation">
              {m.approved_at
                ? `Validée le ${formatDate(m.approved_at, timeZone)}${m.fee_waiver ? " · dérogation « frais à 0 »" : ""}`
                : m.refused_reason
                  ? `Refusée : « ${m.refused_reason} »`
                  : approval === "lost"
                    ? "À revalider (nom ou n° modifié)"
                    : m.requested_at
                      ? `Demandée le ${formatDate(m.requested_at, timeZone)}`
                      : "—"}
            </Row>
            {m.approved_at && (
              <Row label="Instantané validé">
                {m.approved_legal_name} · <span className="mono">{m.approved_siret}</span> · <span className="mono">{m.approved_vtc_registration}</span>
              </Row>
            )}
            <Row label="Convention">{m.terms_version ? `Version ${m.terms_version}${m.terms_accepted_at ? ` · acceptée le ${formatDate(m.terms_accepted_at, timeZone)}` : ""}` : "Non acceptée"}</Row>
            <Row label="Assurance">{m.insurance_confirmed_at ? `Confirmée le ${formatDate(m.insurance_confirmed_at, timeZone)}` : "Non confirmée"}</Row>
            <Row label="Plafond par chauffeur">{formatPrice(m.executor_credit_limit_cents, currency)}</Row>
            {m.suspended_at && (
              <Row label="Suspendue">
                <span className="text-red">
                  le {formatDate(m.suspended_at, timeZone)}
                  {m.suspended_reason ? ` · « ${m.suspended_reason} »` : ""}
                </span>
              </Row>
            )}
          </div>
        )}
        <Link href={`/admin/reseau#org-${orgId}`} prefetch={false} className="inline-block text-[12.5px] text-fg-muted underline-offset-2 hover:text-fg hover:underline">
          Réseau partagé de la plateforme <span aria-hidden>→</span>
        </Link>
      </CardBody>
    </Card>
  );
}
