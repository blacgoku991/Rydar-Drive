import { Logo } from "@/components/brand/logo";

export function StatusScreen({ icon, title, children, actions }: { icon?: React.ReactNode; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-6">
      <div className="grid-bg absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]" />
      <div className="absolute left-1/2 top-1/3 size-[420px] -translate-x-1/2 rounded-full bg-brand/[0.06] blur-[120px]" />
      <div className="relative w-full max-w-md text-center">
        <div className="mb-10 flex justify-center"><Logo size={30} /></div>
        {icon && <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl border border-line-strong bg-ink-700 text-fg-muted [&_svg]:size-6">{icon}</div>}
        <h1 className="text-[24px] font-semibold tracking-tight">{title}</h1>
        <div className="mt-3 text-[14px] leading-relaxed text-fg-muted">{children}</div>
        {actions && <div className="mt-8 flex justify-center gap-2">{actions}</div>}
      </div>
    </main>
  );
}
