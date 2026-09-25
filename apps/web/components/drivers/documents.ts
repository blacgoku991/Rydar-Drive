// Documents chauffeur côté centrale : statut calculé et « document courant » (miroir de
// private.document_state / private.document_superseded, migration 20260924002400).
import type { DocumentState, DocumentType, DriverDocumentItem } from "@rydar/shared";
import { DOCUMENT_TYPE_LABELS } from "@rydar/shared";

export const REQUIRED_DOCUMENT_TYPES: DocumentType[] = ["vtc_card", "driving_license", "identity", "insurance", "vehicle_registration"];
const TYPE_ORDER: DocumentType[] = [...REQUIRED_DOCUMENT_TYPES, "medical", "other"];
const STATE_ORDER: Record<DocumentState, number> = { pending: 0, rejected: 1, expired: 2, expiring: 3, valid: 4 };

export const DOCUMENT_COLUMNS =
  "id, driver_id, type, label, number, issued_at, expires_at, status, file_path, source, review_note, reviewed_at, created_at, updated_at";

export type DocumentRow = Omit<DriverDocumentItem, "status" | "days_left" | "label"> & {
  label: string | null;
  status: "pending" | "valid" | "expired" | "rejected";
};

export type DocumentView = DriverDocumentItem & {
  /** URL signée (stockage) si disponible */
  url?: string | null;
  kind?: "image" | "pdf" | null;
};

/** Date du jour (AAAA-MM-JJ) dans le fuseau de l'organisation. */
export function orgToday(timeZone: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!) / 86_400_000;
};

export function documentState(status: DocumentRow["status"], expiresAt: string | null, today: string): DocumentState {
  if (status === "rejected") return "rejected";
  if (status === "pending") return "pending";
  if (status === "expired" || (expiresAt && expiresAt.slice(0, 10) < today)) return "expired";
  if (expiresAt && dayNumber(expiresAt) <= dayNumber(today) + 30) return "expiring";
  return "valid";
}

function superseded(doc: DocumentRow, all: DocumentRow[]) {
  if (doc.type === "other") return false;
  const key = (x: DocumentRow) => [x.expires_at ? dayNumber(x.expires_at) : -Infinity, new Date(x.created_at).getTime(), x.id] as const;
  const gt = (a: readonly [number, number, string], b: readonly [number, number, string]) =>
    a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  if (doc.status === "valid" || doc.status === "expired") {
    return all.some((y) => y.id !== doc.id && y.type === doc.type && y.status === "valid" && gt(key(y), key(doc)));
  }
  if (doc.status === "rejected") {
    const t = new Date(doc.created_at).getTime();
    return all.some((y) => y.id !== doc.id && y.type === doc.type && (new Date(y.created_at).getTime() > t || (y.created_at === doc.created_at && y.id > doc.id)));
  }
  return false;
}

/** Documents affichés (courants), manquants exigés et résumé. */
export function buildDocumentView(rows: DocumentRow[], timeZone: string) {
  const today = orgToday(timeZone);
  const items: DriverDocumentItem[] = rows
    .filter((r) => !superseded(r, rows))
    .map((r) => ({
      ...r,
      label: r.label?.trim() || DOCUMENT_TYPE_LABELS[r.type] || "Document",
      status: documentState(r.status, r.expires_at, today),
      days_left: r.expires_at ? dayNumber(r.expires_at) - dayNumber(today) : null,
    }))
    .sort(
      (a, b) =>
        TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
        STATE_ORDER[a.status] - STATE_ORDER[b.status] ||
        (b.expires_at ?? "").localeCompare(a.expires_at ?? ""),
    );
  const missing = REQUIRED_DOCUMENT_TYPES.filter((t) => !items.some((d) => d.type === t && ["valid", "expiring", "pending"].includes(d.status)));
  const summary = items.reduce(
    (acc, d) => ({ ...acc, [d.status]: acc[d.status] + 1 }),
    { valid: 0, expiring: 0, expired: 0, pending: 0, rejected: 0 } as Record<DocumentState, number>,
  );
  return { today, items, missing, summary };
}

export function fileKind(path: string | null | undefined): "image" | "pdf" | null {
  if (!path) return null;
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  return ext && ["jpg", "jpeg", "png", "webp", "heic", "gif"].includes(ext) ? "image" : null;
}
