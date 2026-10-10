// Vue d'ensemble du super admin — « À traiter » (docs/REFONTE-PANELS.md, R3) : ce qui attend une décision du
// propriétaire, une ligne par sujet (verbe + nombre + lien vers la page où le traiter). Les nombres sont ceux des
// pastilles du menu : une seule lecture (getAdminTodo, components/admin/platform-data.ts, sous cache() de React),
// partagée par le layout (pastilles) et la page (lignes). Une lecture en échec donne « Lecture impossible », jamais 0.
// Module pur (testé : admin-todo.test.ts).
import type { Tone } from "@rydar/shared";
import type { AdminNavCounts } from "@/components/shell/admin-shell";
import { plural } from "@/lib/wording";

/** Compteurs de « À traiter » et des pastilles du menu ; null : lecture impossible (jamais un faux 0). */
export type AdminTodo = {
  /** Signalements de fraude à examiner (fraud_reports « open ») */
  openReports: number | null;
  /** Paiements de frais Rydar déclarés par les clients, à confirmer (platform_payments « declared ») */
  declaredPayments: number | null;
  /** Baisses de frais à décider (platform_fee_entries « pending », acceptées d'office au bout de 30 jours) */
  pendingReductions: number | null;
  /** Suppressions de compte en échec ou en retard (admin_account_deletions : failed + stalled) */
  failedDeletions: number | null;
  /** Nouvelles demandes du formulaire de contact (contact_requests « new ») */
  newContacts: number | null;
  /** Réseau partagé : organisations à valider (demande ou validation perdue) */
  networkToReview: number | null;
};

/**
 * Informations légales de l'éditeur : identité incomplète (raison sociale, siège, immatriculation : sans elles, aucun
 * client ne peut accepter les CGV ni l'accord de traitement, LEGAL_EDITOR_MISSING) et mentions obligatoires
 * manquantes. null : lecture impossible.
 */
export type AdminLegalTodo = { editorMissing: boolean; missingNotices: number } | null;

export type AdminTodoItem = {
  key: keyof AdminTodo | "legal";
  /** Verbe + nombre (« Examiner 2 signalements de fraude ») ou « Lecture impossible : … » */
  label: string;
  /** Conséquence ou précision, en une phrase */
  detail?: string;
  /** Page où traiter (ancres #a-traiter et #a-valider : clés d'URL existantes) */
  href: string;
  /** Pastille : rouge (blocage, échec), ambre (à faire), lime (nouveau), neutre (lecture impossible) */
  tone: Tone;
  /** Compteur illisible : la ligne le dit au lieu d'afficher 0 */
  unreadable?: boolean;
};

type Line = { key: keyof AdminTodo; href: string; tone: Tone; label: (n: number) => string; topic: string };

/**
 * Sujets dans l'ordre d'urgence (les informations légales passent avant : elles bloquent tous les clients) : fraude et
 * suppressions en échec (obligation légale), argent (un paiement non confirmé peut laisser un client bloqué ; une
 * baisse non décidée est acceptée d'office au bout de 30 jours), réseau partagé, puis nouvelles demandes.
 */
const LINES: Line[] = [
  {
    key: "openReports",
    href: "/admin/signalements",
    tone: "red",
    label: (n) => `Examiner ${plural(n, "signalement de fraude", "signalements de fraude")}`,
    topic: "signalements de fraude",
  },
  {
    key: "failedDeletions",
    href: "/admin/suppressions",
    tone: "red",
    label: (n) => `Vérifier ${plural(n, "suppression de compte en échec ou en retard", "suppressions de compte en échec ou en retard")}`,
    topic: "suppressions de comptes",
  },
  {
    key: "declaredPayments",
    href: "/admin/frais#a-traiter",
    tone: "amber",
    label: (n) => `Confirmer ${plural(n, "paiement déclaré", "paiements déclarés")}`,
    topic: "paiements déclarés",
  },
  {
    key: "pendingReductions",
    href: "/admin/frais#a-traiter",
    tone: "amber",
    label: (n) => `Décider ${plural(n, "baisse de frais", "baisses de frais")}`,
    topic: "baisses de frais",
  },
  {
    key: "networkToReview",
    href: "/admin/reseau#a-valider",
    tone: "amber",
    label: (n) => `Valider ${plural(n, "organisation", "organisations")} pour le réseau partagé`,
    topic: "réseau partagé",
  },
  {
    key: "newContacts",
    href: "/admin/contacts",
    tone: "brand",
    label: (n) => `Répondre à ${plural(n, "demande de contact", "demandes de contact")}`,
    topic: "demandes de contact",
  },
];

const UNREADABLE_DETAIL = "Réessayez dans un instant.";

/** Précision des informations légales : la conséquence d'abord, puis les mentions manquantes. */
function legalDetail(legal: { editorMissing: boolean; missingNotices: number }): string {
  return [
    legal.editorMissing ? "Sans raison sociale, siège et immatriculation, aucun client ne peut accepter les CGV." : "",
    legal.missingNotices > 0
      ? `${plural(legal.missingNotices, "mention obligatoire manquante", "mentions obligatoires manquantes")} dans les mentions légales.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Lignes de « À traiter » : une par sujet non nul, dans l'ordre d'urgence ; un compteur illisible donne « Lecture
 * impossible : … » (jamais 0) ; rien à faire : liste vide (la page dit « Rien à traiter, tout est à jour. »).
 */
export function adminTodoItems(todo: AdminTodo, legal: AdminLegalTodo): AdminTodoItem[] {
  const items: AdminTodoItem[] = [];
  if (legal === null) {
    items.push({ key: "legal", label: "Lecture impossible\u00a0: informations légales de l'éditeur", detail: UNREADABLE_DETAIL, href: "/admin/legal", tone: "neutral", unreadable: true });
  } else if (legal.editorMissing || legal.missingNotices > 0) {
    items.push({
      key: "legal",
      label: "Compléter les informations légales de l'éditeur",
      detail: legalDetail(legal),
      href: "/admin/legal",
      // Identité absente : tous les clients restent bloqués sur l'écran d'acceptation des CGV
      tone: legal.editorMissing ? "red" : "amber",
    });
  }
  for (const line of LINES) {
    const n = todo[line.key];
    if (n === null) items.push({ key: line.key, label: `Lecture impossible\u00a0: ${line.topic}`, detail: UNREADABLE_DETAIL, href: line.href, tone: "neutral", unreadable: true });
    else if (n > 0) items.push({ key: line.key, label: line.label(n), href: line.href, tone: line.tone });
  }
  return items;
}

/**
 * Pastilles du menu (adminNav) à partir des mêmes compteurs : une lecture impossible n'affiche pas de pastille (0), la
 * ligne « Lecture impossible » de la vue d'ensemble le dit. Frais Rydar = paiements déclarés + baisses de frais.
 */
export function adminNavCounts(todo: AdminTodo): Required<AdminNavCounts> {
  return {
    openReports: todo.openReports ?? 0,
    platformToReview: (todo.declaredPayments ?? 0) + (todo.pendingReductions ?? 0),
    deletionsToReview: todo.failedDeletions ?? 0,
    contactsToReview: todo.newContacts ?? 0,
    networkToReview: todo.networkToReview ?? 0,
  };
}

/**
 * Informations légales de la vue d'ensemble : lecture de platform_legal en échec → null (« Lecture impossible ») ;
 * sinon identité incomplète (aucune ligne, ou raison sociale, siège ou immatriculation vide) et mentions manquantes.
 */
export function adminLegalTodo(input: {
  error: unknown;
  editor: { company_name: string | null; address: string | null; registration: string | null } | null;
  missingNotices: number;
}): AdminLegalTodo {
  if (input.error) return null;
  const ed = input.editor;
  const editorMissing = !ed || ![ed.company_name, ed.address, ed.registration].every((v) => !!v?.trim());
  return { editorMissing, missingNotices: input.missingNotices };
}
