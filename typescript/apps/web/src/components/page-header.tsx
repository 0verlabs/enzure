import type { ReactNode } from "react";

/** A page's title row: the h1 and a line under it at the left, the page's actions at the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex max-w-2xl min-w-0 flex-col gap-2">
        <h1 className="flex flex-wrap items-center gap-3 text-3xl leading-tight font-semibold text-balance sm:text-[2.125rem]">
          {title}
        </h1>
        {description ? (
          <p className="text-[0.9375rem] leading-relaxed text-pretty [overflow-wrap:anywhere] text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
