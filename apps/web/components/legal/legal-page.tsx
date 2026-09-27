import Link from "next/link";
import { Logo } from "@/components/brand/logo";

/** Mise en page des pages légales publiques : lecture confortable, sombre, sans menu. */
export function LegalPage({ title, updatedAt, children }: { title: string; updatedAt: string; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh px-5 py-10 sm:py-14">
      <article className="mx-auto w-full max-w-2xl">
        <Link href="/" className="mb-10 inline-flex" aria-label="Rydar Drive">
          <Logo size={24} />
        </Link>
        <h1 className="text-[26px] font-semibold tracking-tight sm:text-[30px]">{title}</h1>
        <p className="mt-2 text-[13px] text-fg-muted">Mise à jour le {updatedAt}</p>
        <div className="legal mt-8 space-y-8 text-[14.5px] leading-relaxed text-fg-muted">{children}</div>
        <footer className="mt-14 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-6 text-[13px] text-fg-muted">
          <Link href="/confidentialite" className="hover:text-fg">Politique de confidentialité</Link>
          <Link href="/suppression-compte" className="hover:text-fg">Supprimer son compte</Link>
        </footer>
      </article>
    </main>
  );
}

/** Section titrée d'une page légale. */
export function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
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
