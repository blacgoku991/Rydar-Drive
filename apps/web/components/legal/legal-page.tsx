import Link from "next/link";
import * as React from "react";
import { Logo } from "@/components/brand/logo";
import { LegalLinks } from "@/components/legal/legal-links";

/**
 * Ancre d'une section de page légale : « 7. Résiliation » → « article-7 » (liens /cgv#article-7 depuis les autres
 * pages) ; sans numéro, le titre en minuscules, sans accents (« Cookies » → « cookies »).
 */
export function sectionId(title: string): string {
  const n = /^(\d+)\.\s/.exec(title);
  if (n) return `article-${n[1]}`;
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** À partir de ce nombre de sections, la page affiche un sommaire (pages longues : CGV, CGU, confidentialité…). */
const TOC_MIN_SECTIONS = 6;

/** Mise en page des pages légales publiques : lecture confortable, sombre, sans menu ; sommaire des pages longues. */
export function LegalPage({ title, updatedAt, children }: { title: string; updatedAt: string; children: React.ReactNode }) {
  const sections = React.Children.toArray(children)
    .filter((c): c is React.ReactElement<{ title: string }> => React.isValidElement(c) && c.type === LegalSection)
    .map((c) => c.props.title);
  return (
    <main id="contenu" tabIndex={-1} className="min-h-dvh px-5 py-10 outline-none sm:py-14">
      <article className="mx-auto w-full max-w-2xl">
        <Link href="/" className="mb-10 inline-flex" aria-label="Rydar Drive">
          <Logo size={24} />
        </Link>
        <h1 className="text-[26px] font-semibold tracking-tight sm:text-[30px]">{title}</h1>
        <p className="mt-2 text-[13px] text-fg-muted">Mise à jour le {updatedAt}</p>
        {sections.length >= TOC_MIN_SECTIONS && (
          <nav aria-label="Sommaire" className="mt-8 rounded-xl border border-line px-4 py-3.5 text-[13.5px]">
            <p className="mb-2 font-medium text-fg">Sommaire</p>
            <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {sections.map((t) => (
                <li key={t}>
                  <a href={`#${sectionId(t)}`} className="text-fg-muted underline decoration-white/20 underline-offset-2 hover:text-fg">
                    {t}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="legal mt-8 space-y-8 text-[14.5px] leading-relaxed text-fg-muted">{children}</div>
        <footer className="mt-14 border-t border-line pt-6">
          <LegalLinks className="text-[13px]" withDeletion />
        </footer>
      </article>
    </main>
  );
}

/** Section titrée d'une page légale, avec son ancre (sectionId). */
export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section id={sectionId(title)}>
      <h2 className="mb-3 text-[17px] font-semibold text-fg">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Liste à puces des pages légales. */
export function LegalList({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-fg-subtle">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
