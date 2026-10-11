import type { ReactNode } from "react";
import { Logo } from "@kaibot/shared";

interface AuthPanelStep {
  /** 1-based index label, e.g. "1" / "2". */
  index: string;
  /** Mono-caps step label, e.g. "ACCOUNT". */
  label: string;
  active: boolean;
}

interface AuthPanelProps {
  /** Mono-caps role line under the product name (e.g. "SIGN IN TO CONTINUE"). */
  role: string;
  /** Optional 2-step stepper rendered under the masthead. */
  steps?: AuthPanelStep[];
  /** Form / body content. */
  children: ReactNode;
  /** Footer node — the primary button (+ optional ghost action). */
  footer?: ReactNode;
  /** Tauri drag region on the outer container (desktop windows). */
  dragRegion?: boolean;
}

/**
 * Gridline Tokyo auth shell: a centered max-w-[360px] column framed by a single
 * squared hairline (no rounded card). Masthead (Logo + product name + mono-caps
 * role) over a faint divider, a padded body, and a footer for the primary action.
 * Shared by Login and the Setup onboarding branches.
 */
export function AuthPanel({ role, steps, children, footer, dragRegion }: AuthPanelProps) {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-background p-8"
      data-tauri-drag-region={dragRegion ? true : undefined}
    >
      <div className="w-full max-w-[360px] border border-border bg-[hsl(var(--surface-container-low))]">
        {/* Masthead */}
        <div className="flex flex-col items-center gap-3 border-b border-border/60 px-6 py-6">
          <Logo size={48} />
          <div className="text-center space-y-1">
            <h1 className="font-heading text-[19px] font-bold tracking-tight text-foreground">
              KaiBot Terminal
            </h1>
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {role}
            </p>
          </div>
        </div>

        {/* Stepper */}
        {steps && steps.length > 0 && (
          <div className="flex border-b border-border/60">
            {steps.map((s) => (
              <div
                key={s.index}
                className={`flex-1 border-r border-border/60 px-3 py-2.5 text-center font-mono text-[10px] uppercase tracking-widest last:border-r-0 ${
                  s.active
                    ? "border-b-2 border-b-primary text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                Step {s.index}/{steps.length} · {s.label}
              </div>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="px-6 py-5">{children}</div>

        {/* Footer */}
        {footer && <div className="border-t border-border/60 px-6 py-4 space-y-2">{footer}</div>}
      </div>
    </div>
  );
}
