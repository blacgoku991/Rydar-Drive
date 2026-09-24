import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("relative border-b border-line", className)}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgb(200_240_60/0.05),transparent_55%)]" />
      <div className="relative mx-auto flex max-w-[1400px] flex-wrap items-end justify-between gap-4 px-6 pb-6 pt-8 lg:px-10">
        <div className="min-w-0">
          {eyebrow && <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-subtle">{eyebrow}</div>}
          <h1 className="text-[26px] font-semibold tracking-tight text-fg">{title}</h1>
          {description && <p className="mt-1.5 max-w-2xl text-[14px] text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="relative mx-auto max-w-[1400px] px-6 lg:px-10">{children}</div>}
    </header>
  );
}

export function PageBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("mx-auto max-w-[1400px] px-6 py-8 lg:px-10", className)}>{children}</div>;
}

export function StatCard({
  label,
  value,
  sub,
  tone,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "brand" | "amber" | "red" | "cyan" | "blue";
  icon?: React.ReactNode;
}) {
  const color = { brand: "text-brand", amber: "text-amber", red: "text-red", cyan: "text-cyan", blue: "text-blue" }[tone ?? "brand"];
  return (
    <div className="surface relative overflow-hidden rounded-xl p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-subtle">{label}</span>
        {icon && <span className="text-fg-subtle [&_svg]:size-4">{icon}</span>}
      </div>
      <div className={cn("mt-2 text-[26px] font-semibold leading-none tracking-tight", tone ? color : "text-fg")}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] text-fg-subtle">{sub}</div>}
    </div>
  );
}
