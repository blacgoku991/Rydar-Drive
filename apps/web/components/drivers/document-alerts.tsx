import { DOCUMENT_STATE_META, documentStateLabel, formatDate, type OrgDocumentAlerts } from "@rydar/shared";
import { ChevronRight, FileWarning } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

/** Encart « Documents à surveiller » (org_document_alerts) : à valider, expirés, bientôt échus. */
export function DocumentAlertsCard({ alerts }: { alerts: OrgDocumentAlerts }) {
  const { counts } = alerts;
  const total = counts.pending + counts.expired + counts.expiring;
  if (!total) return null;
  const items = [...alerts.pending, ...alerts.expired, ...alerts.expiring];
  const shown = items.slice(0, 6);
  const tiles = [
    { key: "pending", label: "À valider", n: counts.pending, tone: "text-blue" },
    { key: "expired", label: "Expirés", n: counts.expired, tone: "text-red" },
    { key: "expiring", label: "Expirent sous 30 j", n: counts.expiring, tone: "text-amber" },
  ];
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-amber/10 text-amber">
            <FileWarning className="size-4" />
          </div>
          <div>
            <h3 className="text-[14px] font-semibold tracking-tight">Documents à surveiller</h3>
            <p className="mt-0.5 text-[12.5px] text-fg-muted">Dépôts des chauffeurs à valider et échéances proches.</p>
          </div>
        </div>
        <div className="flex gap-5 pl-11 sm:pl-0">
          {tiles.map((t) => (
            <div key={t.key} className="text-right max-sm:text-left">
              <p className={cn("num text-[20px] font-semibold leading-none", t.n ? t.tone : "text-fg-subtle")}>{t.n}</p>
              <p className="mt-1 text-[11.5px] text-fg-subtle">{t.label}</p>
            </div>
          ))}
        </div>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((doc) => {
          const name = `${doc.driver.first_name} ${doc.driver.last_name}`;
          const meta = DOCUMENT_STATE_META[doc.status];
          return (
            <li key={doc.id}>
              <Link href={`/dashboard/drivers/${doc.driver.id}`} className="group flex items-center gap-3 px-5 py-2.5 transition-colors hover:bg-white/[0.025]">
                <Avatar name={name} src={doc.driver.photo_url} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {name} <span className="font-normal text-fg-subtle">· {doc.label}</span>
                  </p>
                  <p className="truncate text-[11.5px] text-fg-subtle">
                    {doc.status === "pending"
                      ? `Déposé le ${formatDate(doc.created_at)}${doc.expires_at ? ` · échéance ${formatDate(doc.expires_at)}` : ""}`
                      : doc.expires_at
                        ? `Échéance ${formatDate(doc.expires_at)}`
                        : "Sans échéance"}
                  </p>
                </div>
                <Badge tone={meta.tone} pulse={doc.status === "pending"}>
                  {documentStateLabel(doc.status, doc.days_left)}
                </Badge>
                <ChevronRight className="size-4 shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
      </ul>
      {items.length > shown.length && (
        <p className="border-t border-line px-5 py-2.5 text-[12px] text-fg-subtle">+ {items.length - shown.length} autre{items.length - shown.length > 1 ? "s" : ""} document{items.length - shown.length > 1 ? "s" : ""}</p>
      )}
    </Card>
  );
}
