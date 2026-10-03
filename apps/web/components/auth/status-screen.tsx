import { Logo } from "@/components/brand/logo";
import { LegalLinks } from "@/components/legal/legal-links";

export function StatusScreen({ icon, title, children, actions }: { icon?: React.ReactNode; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <main id="contenu" tabIndex={-1} className="relative grid min-h-dvh place-items-center overflow-hidden px-6 outline-none">
      <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="absolute left-1/2 top-1/3 size-[420px] -translate-x-1/2 rounded-full bg-brand/[0.06] blur-[120px]" />
      <div className="relative w-full max-w-md text-center">
        <div className="mb-10 flex justify-center"><Logo size={30} /></div>
        {icon && <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted [&_svg]:size-6">{icon}</div>}
        <h1 className="text-[24px] font-semibold tracking-tight">{title}</h1>
        <div className="mt-3 text-[14px] leading-relaxed text-fg-muted">{children}</div>
        {actions && <div className="mt-8 flex justify-center gap-2">{actions}</div>}
        {/* Pages légales atteignables depuis chaque écran (connexion, mot de passe, compte suspendu…) */}
        <LegalLinks
          className="mt-12 justify-center text-[12px]"
          only={["/mentions-legales", "/cgu", "/confidentialite", "/cookies", "/accessibilite"]}
        />
      </div>
    </main>
  );
}
