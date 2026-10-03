import { describe, expect, it } from "vitest";
import { matchFixedFare } from "./pricing";
import { apiKeyCreateSchema, bookingRequestSchema, bookingSiteSchema, isReservedSubdomain, organizationCreateSchema, RESERVED_SUBDOMAINS, slugSchema } from "./schemas";

// Audit « public » : sous-domaines réservés, clés « navigateur », pot de miel du mini-site, forfaits par ville.

describe("sous-domaines réservés (mini-site, identifiant de centrale)", () => {
  it("refuse les noms de la plateforme et tout ce qui commence par rydar", () => {
    for (const name of ["admin", "support", "api", "login", "securite", "facturation", "www", "rydar", "rydar-support", "Rydardrive"]) {
      expect(slugSchema.safeParse(name).success, name).toBe(false);
    }
    expect(slugSchema.safeParse("support").error?.issues[0]?.message).toBe("Nom réservé à la plateforme");
    expect(RESERVED_SUBDOMAINS.every((s) => isReservedSubdomain(s))).toBe(true);
  });

  it("accepte les noms de centrale ordinaires", () => {
    for (const name of ["elite-paris", "centrale-express", "vtc-support-75", "adminvtc", "ma-centrale"]) {
      expect(slugSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it("s'applique au sous-domaine du mini-site et à l'identifiant d'une nouvelle centrale", () => {
    const site = {
      enabled: true, subdomain: "admin", primary_color: "#C8F03C", vehicle_categories: ["standard"], show_price_estimate: true,
      phone: "01 23 45 67 89", email: "contact@centrale.example",
      legal_mentions: "Élite Paris SAS, 1 rue de l'Exemple, 75001 Paris. Paiement : carte ou espèces à bord.",
    };
    expect(bookingSiteSchema.safeParse(site).success).toBe(false);
    expect(bookingSiteSchema.safeParse({ ...site, subdomain: "elite-paris" }).success).toBe(true);
    expect(bookingSiteSchema.safeParse({ ...site, subdomain: null }).success).toBe(true);
    const org = { name: "Support", slug: "support", email: "a@b.fr", ownerName: "Karim Benali", ownerEmail: "k@b.fr" };
    expect(organizationCreateSchema.safeParse(org).success).toBe(false);
    expect(organizationCreateSchema.safeParse({ ...org, slug: "support-vtc" }).success).toBe(true);
  });
});

describe("clé API « navigateur » (origines autorisées)", () => {
  const base = { name: "Site web", rateLimitPerMinute: 60 };

  it("création de courses seule quand des origines sont saisies", () => {
    const res = apiKeyCreateSchema.safeParse({ ...base, scopes: ["rides:create", "rides:read"], allowedOrigins: ["https://www.centrale.fr"] });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toMatch(/seule la création de courses/);
    expect(apiKeyCreateSchema.safeParse({ ...base, scopes: ["rides:cancel", "rides:create"], allowedOrigins: ["https://www.centrale.fr"] }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...base, scopes: ["rides:create"], allowedOrigins: ["https://www.centrale.fr"] }).success).toBe(true);
  });

  it("clé serveur (sans origine) : toutes les portées restent possibles", () => {
    expect(apiKeyCreateSchema.safeParse({ ...base, scopes: ["rides:create", "rides:read", "rides:cancel"], allowedOrigins: [] }).success).toBe(true);
    expect(apiKeyCreateSchema.safeParse({ ...base, scopes: ["rides:read"] }).success).toBe(true);
  });
});

describe("mini-site : pot de miel", () => {
  const valid = {
    pickup: { address: "Gare de Lyon, 75012 Paris", lat: 48.8443, lng: 2.3743 },
    dropoff: { address: "Opéra, 75009 Paris", lat: 48.8719, lng: 2.3316 },
    when: "now", customerName: "Jean Client", customerPhone: "0612345678", passengers: 1, luggage: 0,
    vehicleCategory: "standard", consent: true,
  };

  it("un pot de miel rempli passe la validation (le robot n'est pas prévenu) et reste lisible par l'action", () => {
    const res = bookingRequestSchema.safeParse({ ...valid, website: "http://spam.example" });
    expect(res.success).toBe(true);
    expect(res.data?.website).toBe("http://spam.example");
    expect(bookingRequestSchema.safeParse({ ...valid, website: "" }).data?.website).toBe("");
  });
});

describe("forfaits : la ville, pas un nom de voie", () => {
  const rule = {
    fixed_fares: [
      { label: "Paris ↔ CDG", price_cents: 5500 },
      { label: "Nice ↔ Monaco", price_cents: 9000 },
    ],
  };
  const cdg = "Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France";

  it("« Avenue de Paris, Versailles » ou « Rue de Paris, Vincennes » ne sont pas Paris", () => {
    expect(matchFixedFare(rule, "Avenue de Paris, 78000 Versailles", cdg)).toBeNull();
    expect(matchFixedFare(rule, "12 Avenue de Paris 78000 Versailles", cdg)).toBeNull();
    expect(matchFixedFare(rule, "Rue de Paris, 94300 Vincennes", cdg)).toBeNull();
    expect(matchFixedFare(rule, "Boulevard de Nice, 06400 Cannes", "Place du Casino, 98000 Monaco")).toBeNull();
  });

  it("la commune Paris est reconnue sous ses formes usuelles", () => {
    for (const a of [
      "Gare de Lyon, Place Louis-Armand, 75012 Paris",
      "10 Rue de Rivoli 75004 Paris",
      "Tour Eiffel, Paris, France",
      "Hôtel Ritz, Paris 1er",
      "Paris",
      "Paris Gare de Lyon",
      "Gare du Nord Paris",
    ]) {
      expect(matchFixedFare(rule, a, cdg)?.price_cents, a).toBe(5500);
    }
    expect(matchFixedFare(rule, "Promenade des Anglais, 06000 Nice", "Place du Casino, 98000 Monaco")?.price_cents).toBe(9000);
    expect(matchFixedFare(rule, "Place Masséna, Nice", "Monaco")?.price_cents).toBe(9000);
  });
});
