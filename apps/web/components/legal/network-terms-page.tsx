// Pages publiques du réseau partagé (/reseau-partage/conditions, /reseau-partage/chauffeur) : mise en page des pages
// légales, version de la convention, bandeau « Texte en cours de relecture juridique » tant que NETWORK_TERMS_REVIEWED
// vaut false. Servies telles quelles sur les mini-sites (proxy.ts, LEGAL_PATHS), comme les autres pages légales.
import { NETWORK_TERMS_REVIEWED, NETWORK_TERMS_VERSION, networkText } from "@rydar/shared";
import Link from "next/link";
import { LegalList, LegalPage, LegalSection } from "@/components/legal/legal-page";
import { NETWORK_TERMS_REVIEW_NOTICE, NETWORK_TERMS_UPDATED_AT, type NetworkLegalDoc } from "@/components/legal/network-terms";
import { getLegalInfo } from "@/lib/legal";

export async function NetworkTermsDocument({ doc, related }: { doc: NetworkLegalDoc; related: { href: string; label: string } }) {
  const legal = await getLegalInfo();
  const vars = {
    version: NETWORK_TERMS_VERSION,
    // Raison sociale pas encore renseignée (/admin/legal) : jamais « Rydar Drive (Rydar Drive) »
    editor: legal.nameSet ? legal.name : "voir les mentions légales",
    contact: legal.email || "l'adresse indiquée dans les mentions légales",
  };
  // Typographie française : espace insécable avant « : ; ! ? » et à l'intérieur des guillemets (jamais un « » » seul
  // en début de ligne)
  const t = (s: string) => networkText(s, vars).replace(/ ([:;!?»])/g, "\u00a0$1").replace(/« /g, "«\u00a0");
  const link = "text-fg underline underline-offset-2";
  return (
    <LegalPage title={doc.title} updatedAt={NETWORK_TERMS_UPDATED_AT}>
      {!NETWORK_TERMS_REVIEWED && (
        <p role="note" className="rounded-xl border border-amber/30 bg-amber/[0.07] px-4 py-3 text-[13.5px] leading-relaxed text-amber">
          {t(NETWORK_TERMS_REVIEW_NOTICE)}
        </p>
      )}
      {doc.intro.map((p) => (
        <p key={p}>{t(p)}</p>
      ))}
      {doc.sections.map((s) => (
        <LegalSection key={s.title} title={s.title}>
          {s.paragraphs?.map((p) => (
            <p key={p}>{t(p)}</p>
          ))}
          {s.items && <LegalList items={s.items.map(t)} />}
        </LegalSection>
      ))}
      <p className="text-[13.5px]">
        Voir aussi :{" "}
        <Link href={related.href} className={link}>{related.label}</Link>
        {" · "}
        <Link href="/cgv" className={link}>CGV</Link>
        {" · "}
        <Link href="/cgu" className={link}>CGU</Link>
        {" · "}
        <Link href="/confidentialite" className={link}>Politique de confidentialité</Link>
      </p>
    </LegalPage>
  );
}
