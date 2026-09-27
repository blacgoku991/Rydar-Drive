// Justificatifs : types déposables depuis l'application. Module sans dépendance native (document-types.test.ts).
import { ERROR_MESSAGES, type DocumentDisplayState, type DocumentType } from "@rydar/shared";

/**
 * Types que le serveur refuse au dépôt (driver_submit_document → TYPE_NOT_ALLOWED, migration 20260924004300) :
 * visite médicale (donnée de santé, plus collectée). Les fiches existantes restent affichées, sans action.
 */
const NOT_UPLOADABLE: ReadonlySet<DocumentType> = new Set<DocumentType>(["medical"]);

export const canUploadDocument = (type: DocumentType) => !NOT_UPLOADABLE.has(type);

/** Refus affiché AVANT l'envoi du fichier (sinon fichier orphelin dans le stockage). */
export const DOCUMENT_TYPE_REFUSED = ERROR_MESSAGES.TYPE_NOT_ALLOWED ?? "Ce type de document ne se dépose plus dans l'application.";

/** États à traiter par le chauffeur (manquant, refusé, expiré, bientôt échu). */
export const isTodo = (s: DocumentDisplayState) => s === "missing" || s === "rejected" || s === "expired" || s === "expiring";

/** Document à traiter ET que le chauffeur peut déposer depuis l'application. */
export const needsAction = (e: { type: DocumentType; state: DocumentDisplayState }) => isTodo(e.state) && canUploadDocument(e.type);
