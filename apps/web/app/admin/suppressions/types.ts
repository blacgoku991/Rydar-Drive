// Super admin — suppressions de comptes chauffeur : formes renvoyées par admin_find_drivers et
// admin_account_deletions (migration 20260924004000).

/** Chauffeur trouvé par e-mail (fiche ou compte de connexion) ou téléphone, toutes centrales. */
export type DriverMatch = {
  id: string;
  number: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string;
  status: "invited" | "active" | "inactive" | "suspended";
  application_status: "pending" | "approved" | "rejected" | null;
  banned: boolean;
  joined_via: "dashboard" | "join_link";
  created_at: string;
  /** E-mail du compte de connexion (peut différer de celui de la fiche) */
  account_email: string | null;
  has_account: boolean;
  /** Compte qui sert aussi à gérer une centrale ou la plateforme : seul le profil chauffeur sera supprimé */
  keep_auth: boolean;
  /** Courses attribuées en cours : suppression refusée tant qu'il y en a */
  rides_assigned: number;
  organization: { id: string; name: string; status: string };
};

/** Suppression en file (private.account_deletions), sans identifiant de compte. */
export type DeletionItem = {
  deletion_id: string;
  driver_id: string;
  organization_id: string;
  number: number;
  keep_auth: boolean;
  source: "app" | "admin" | "repair";
  storage_done: boolean;
  auth_done: boolean;
  done: boolean;
  pending: boolean;
  abandoned: boolean;
  attempts: number;
  last_error: string | null;
  requested_at: string;
  done_at: string | null;
  next_attempt_at: string;
  status: "done" | "pending" | "failed";
  /** En cours mais pas reprise depuis plus de 30 min après l'échéance : le worker ne traite pas la file */
  stalled: boolean;
  has_account: boolean;
  organization: { id: string; name: string } | null;
};

/** pending : en cours (dont `stalled` bloquées) ; failed : abandonnées après 10 essais. */
export type DeletionQueue = { items: DeletionItem[]; pending: number; failed: number; stalled: number };
