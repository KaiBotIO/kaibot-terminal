import type { ReactNode } from "react";
import { useAtomValue } from "jotai";
import { effectiveBrandVariantAtom } from "../../atoms/brand";
import { cn } from "../../lib/utils";
import { Logo } from "../brand/Logo";
import { AuthBackground } from "./AuthBackground";

interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Custom background for the right panel. Pass `null` to disable entirely. */
  background?: ReactNode | null;
  homeHref?: string;
}

export function AuthShell({
  title,
  subtitle,
  children,
  background,
  homeHref = "https://kaibot.io",
}: AuthShellProps) {
  const brand = useAtomValue(effectiveBrandVariantAtom);

  const backgroundNode =
    background === undefined ? <AuthBackground /> : background;

  return (
    <div
      className={cn(
        "flex h-screen bg-background relative flex-col lg:flex-row overflow-hidden",
        brand === "kaibot" && "theme-kaibot",
      )}
    >
      {/* Left panel — form */}
      <div className="w-full flex-1 lg:flex-none lg:w-[45%] flex flex-col items-center p-4 sm:p-6 lg:p-8 relative overflow-y-auto">
        {/* Desktop logo top-left */}
        <div className="absolute top-6 left-6 z-10 hidden lg:block">
          <Logo size={48} href={homeHref} />
        </div>

        <div className="w-full max-w-[420px] my-auto">
          <div className="border border-border bg-[hsl(var(--surface-container-low))] p-4 sm:p-6 space-y-5 sm:space-y-6">
            {/* Mobile logo */}
            <div className="block lg:hidden mb-2">
              <Logo size={40} href={homeHref} />
            </div>

            <div>
              <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
                {title}
              </h1>
              {subtitle && (
                <p className="text-sm text-muted-foreground mt-1">
                  {subtitle}
                </p>
              )}
            </div>

            {children}
          </div>
        </div>
      </div>

      {/* Right panel — background */}
      {backgroundNode !== null && (
        <div className="hidden lg:block lg:w-[55%] relative">
          {backgroundNode}
          <div className="absolute inset-0 bg-gradient-to-r from-background via-background/60 to-transparent pointer-events-none" />
        </div>
      )}
    </div>
  );
}
