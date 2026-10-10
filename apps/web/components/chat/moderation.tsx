"use client";
// Modération du fil « Toute la flotte » (20260924004100) : messages à modérer (les chauffeurs demandent leur retrait),
// à supprimer ou à ignorer, et confirmation de suppression. L'organisation modère son fil ; Rydar Drive fournit l'outil.
// « Signalement » reste réservé aux alertes de la route (police, bouchons…), le mot de l'application chauffeur.
import { FLEET_REPORT_META, fleetReportTitle, type ChatMessage, type ChatModerationItem, type FleetReportType } from "@rydar/shared";
import { ChevronDown, Flag, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ago, clockTime } from "./chat-utils";

/** Auteur affiché (« Karim T. », « Lina · équipe » : membre de votre équipe). */
const authorOf = (m: ChatMessage) => (m.author_type === "user" ? `${m.author_name} · équipe` : m.author_name);

/** Texte du message tel qu'il apparaît dans le fil (titre pour un signalement de la flotte). */
function messageText(m: ChatMessage) {
  if (!m.report_type) return m.body;
  const type = m.report_type as FleetReportType;
  return `${fleetReportTitle(type)} — ${m.body}`;
}

/** « À modérer », « À modérer · demandé par 2 chauffeurs » */
export const reportedLabel = (n: number) => (n > 1 ? `À modérer · demandé par ${n} chauffeurs` : "À modérer");

/** « 1 message à modérer », « 3 messages à modérer » */
export const moderationCountLabel = (n: number) => `${n} message${n > 1 ? "s" : ""} à modérer`;

/** Action de modération en cours sur un message (un seul à la fois). */
export type ModerationBusy = { id: string; action: "remove" | "dismiss" } | null;

/**
 * Bandeau « Messages à modérer » en tête du fil flotte : un élément par message (motifs et chauffeurs qui demandent son
 * retrait), avec « Supprimer le message » (confirmation) et « Ignorer ».
 */
export function ModerationPanel({
  items,
  total,
  timeZone,
  now,
  busy,
  onRemove,
  onDismiss,
}: {
  items: ChatModerationItem[];
  /** Nombre total de messages à modérer (peut dépasser la page chargée) */
  total: number;
  timeZone: string;
  now: number;
  /** Action en cours (suppression ou classement) */
  busy: ModerationBusy;
  onRemove: (m: ChatMessage) => void;
  onDismiss: (item: ChatModerationItem) => void;
}) {
  const [open, setOpen] = useState(true);
  if (!items.length) return null;
  return (
    <section className="shrink-0 border-b border-line bg-amber/[0.04]" aria-label="Messages à modérer">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left sm:px-6"
      >
        <Flag aria-hidden className="size-4 shrink-0 text-amber" />
        <span className="min-w-0 flex-1 text-[13px] font-semibold">{moderationCountLabel(total)}</span>
        <span className="hidden text-[12px] text-fg-muted sm:inline">Vos chauffeurs demandent leur retrait</span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-fg-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="max-h-[38vh] space-y-2 overflow-y-auto px-3 pb-3 sm:px-5">
          {items.map((item) => {
            const m = item.message;
            const pending = busy?.id === m.id ? busy.action : null;
            return (
              <li key={m.id} className="rounded-xl border border-line bg-ink-800/80 p-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-fg-muted">
                  <span className="font-medium text-fg-muted">{authorOf(m)}</span>
                  <span>
                    {ago(m.created_at, now)} · <span className="font-mono">{clockTime(m.created_at, timeZone)}</span>
                  </span>
                  {m.report_type && <span>{FLEET_REPORT_META[m.report_type as FleetReportType]?.label}</span>}
                </div>
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-[1.45] text-fg">{messageText(m)}</p>
                <ul className="mt-2 space-y-0.5 text-[12px] text-fg-muted">
                  {item.reports.map((r) => (
                    <li key={r.id} className="flex gap-1.5">
                      <Flag className="mt-[3px] size-3 shrink-0 text-amber" aria-hidden />
                      <span className="min-w-0">
                        <span className="text-fg-muted">{r.reporter_name}</span>
                        {r.reason ? (
                          <span className="text-fg-muted">
                            {"\u00A0: «\u00A0"}
                            {r.reason}
                            {"\u00A0»"}
                          </span>
                        ) : (
                          <span className="text-fg-muted"> · sans motif</span>
                        )}
                        <span className="text-fg-muted"> · {ago(r.created_at, now)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Button variant="danger" size="sm" disabled={!!busy} loading={pending === "remove"} onClick={() => onRemove(m)}>
                    <Trash2 /> Supprimer le message
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!busy}
                    loading={pending === "dismiss"}
                    onClick={() => onDismiss(item)}
                    title="Le message est acceptable : la demande de retrait est classée"
                  >
                    Ignorer
                  </Button>
                  <span className="ml-auto text-[12px] text-amber">{reportedLabel(item.report_count)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Confirmation de suppression d'un message du fil flotte. */
export function RemoveMessageDialog({
  message,
  pending,
  onConfirm,
  onClose,
}: {
  message: ChatMessage | null;
  pending: boolean;
  onConfirm: (m: ChatMessage) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!message} onOpenChange={(open) => !open && !pending && onClose()}>
      {message && (
        <DialogContent
          size="sm"
          title="Supprimer ce message ?"
          description="Il disparaît pour toute la flotte, sur le tableau de bord comme dans l'application. Les demandes de retrait sont closes."
        >
          <blockquote className="rounded-xl border border-line bg-white/[0.03] px-3.5 py-2.5">
            <p className="text-[12px] text-fg-muted">{authorOf(message)}</p>
            <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-[13px] text-fg">{messageText(message)}</p>
          </blockquote>
          <DialogFooter backDisabled={pending}>
            <Button variant="danger" loading={pending} onClick={() => onConfirm(message)}>
              <Trash2 /> Supprimer le message
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Bouton discret « Supprimer » posé à côté d'un message du fil flotte (visible au survol, au clavier, et toujours au toucher). */
export function RemoveMessageButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Supprimer ce message"
      title="Supprimer ce message"
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-md text-fg-muted opacity-0 transition-opacity hover:bg-white/[0.06] hover:text-red focus-visible:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100",
        className,
      )}
    >
      <Trash2 className="size-3.5" />
    </button>
  );
}
