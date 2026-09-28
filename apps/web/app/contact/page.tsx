import { contactTopicFromParam } from "@rydar/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { ContactForm } from "@/components/marketing/contact-form";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { PageHeader } from "@/components/marketing/page-header";
import { marketingMetadata } from "@/components/marketing/seo";
import { fr } from "@/components/marketing/typo";
import { loadContactPlans } from "@/lib/contact";

const DESCRIPTION = fr(
  "Demandez un tarif, posez une question ou proposez un partenariat : l'équipe Rydar Drive reçoit votre demande et vous répond par e-mail.",
);

export const metadata: Metadata = marketingMetadata({ path: "/contact", title: "Contact", description: DESCRIPTION });

const STEPS = [
  "Votre demande arrive directement à l'équipe Rydar Drive.",
  "Vous recevez un e-mail qui confirme sa bonne réception.",
  "Nous vous répondons par e-mail, ou par téléphone si vous nous laissez un numéro.",
];

const link = "text-fg underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-brand";

export default async function ContactPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  // Sujet choisi par le lien d'origine (?sujet=tarif…) ; lien « Contact » seul : question
  const topic = contactTopicFromParam(sp.sujet) ?? "question";
  const offer = Array.isArray(sp.offre) ? sp.offre[0] : sp.offre;
  const plans = await loadContactPlans();
  const pricing = topic === "pricing";

  return (
    <MarketingShell>
      <PageHeader
        id="contact-titre"
        eyebrow="Contact"
        title={pricing ? "Demander un tarif" : "Nous contacter"}
        intro={
          pricing
            ? fr("Dites-nous en quelques mots comment fonctionne votre centrale : nous vous proposons la formule adaptée à votre flotte ou à votre réseau de chauffeurs.")
            : DESCRIPTION
        }
      />
      <section aria-label="Formulaire de contact" className="relative z-10">
        <div className="mx-auto grid max-w-6xl items-start gap-10 px-4 pb-24 sm:px-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)] lg:gap-14">
          <div className="surface rounded-2xl p-5 sm:p-8">
            <ContactForm defaultTopic={topic} defaultPlan={offer?.trim().toLowerCase() || null} plans={plans} />
          </div>
          <aside aria-labelledby="contact-ensuite" className="space-y-8 lg:pt-4">
            <div>
              <h2 id="contact-ensuite" className="text-[12px] font-semibold uppercase tracking-[0.16em] text-fg">
                Ensuite
              </h2>
              <ol className="mt-4 space-y-4">
                {STEPS.map((s, i) => (
                  <li key={s} className="flex gap-3 text-[14px] leading-relaxed text-fg-muted">
                    <span className="num grid size-6 shrink-0 place-items-center rounded-full border border-line-strong text-[12px] text-fg">
                      {i + 1}
                    </span>
                    {fr(s)}
                  </li>
                ))}
              </ol>
            </div>
            <div className="border-t border-line pt-6 text-[14px] text-fg-muted">
              <p>
                {fr("Déjà client ?")}{" "}
                <Link href="/login" className={link}>
                  Se connecter
                </Link>
              </p>
            </div>
          </aside>
        </div>
      </section>
    </MarketingShell>
  );
}
