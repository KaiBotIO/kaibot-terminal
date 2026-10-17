import type { CSSProperties } from "react";
import { useAtomValue } from "jotai";
import { effectiveBrandVariantAtom } from "../../atoms/brand";
import { cn } from "../../lib/utils";

interface LogoProps {
  size?: number;
  className?: string;
  showText?: boolean;
  textClassName?: string;
  href?: string;
  srcOverride?: { auric?: string; kaibot?: string };
  /**
   * Render the mark as an inline, brand-aware SVG instead of the brand PNG.
   * The robot body follows `--kb-accent` (gold in auric, blue in classic), so
   * it tracks the brand variant; the facial cut-outs use the page background.
   * The wordmark colour is left to `textClassName` (e.g. white in the navbar).
   */
  svg?: boolean;
}

export function Logo({
  size = 40,
  className,
  showText = false,
  textClassName,
  href,
  srcOverride,
  svg = false,
}: LogoProps) {
  const brand = useAtomValue(effectiveBrandVariantAtom);
  const src =
    brand === "kaibot"
      ? srcOverride?.kaibot ?? "/icon_transparent.png"
      : srcOverride?.auric ?? "/logo_gold.png";

  const img = svg ? (
    <svg
      viewBox="0 0 1073 907"
      width={size}
      height={size}
      aria-label="KaiBot"
      className={cn("object-contain shrink-0", className)}
      style={
        {
          width: size,
          height: size,
          "--logo-fill": "var(--kb-accent)",
          "--logo-detail": "var(--kb-bg)",
        } as CSSProperties
      }
    >
      <g fill="var(--logo-fill)">
        <rect x="0" y="485" width="43" height="182" />
        <rect x="1031" y="485" width="42" height="182" />
        <rect x="898" y="120" width="36" height="130" />
        <circle cx="915.5" cy="71.5" r="71.5" />
        <path d="M 273 245 H 1020 C 1024.4 245 1031 254.5 1031 255 V 678 C 1031 792.3 913.8 907 803 907 H 53 C 51 907 43 900.1 43 898 V 469 C 43 371.8 148.8 245 273 245 Z" />
      </g>
      <path
        d="M 277 270 H 993 C 1000.3 270 1003 279.5 1003 280 V 675 C 1003 777.9 891.3 882 798 882 H 80 C 79.5 882 70 879.3 70 872 V 493 C 70 349.4 201.5 270 277 270 Z"
        fill="none"
        stroke="var(--logo-detail)"
        strokeWidth="20"
      />
      <circle cx="299.5" cy="558.5" r="61.9" fill="none" stroke="var(--logo-detail)" strokeWidth="23.3" />
      <circle cx="774.5" cy="558.5" r="61.9" fill="none" stroke="var(--logo-detail)" strokeWidth="23.3" />
      <g fill="var(--logo-detail)">
        <rect x="452" y="656" width="6" height="216" /><rect x="426" y="693" width="58" height="147" />
        <rect x="532" y="598" width="7" height="234" /><rect x="506" y="635" width="59" height="147" />
        <rect x="615" y="627" width="7" height="245" /><rect x="589" y="693" width="58" height="166" />
      </g>
    </svg>
  ) : (
    <img
      src={src}
      alt="KaiBot"
      width={size}
      height={size}
      className={cn("object-contain", className)}
      style={{ width: size, height: size }}
    />
  );

  const content = showText ? (
    <span className="inline-flex items-center gap-2">
      {img}
      <span
        className={cn(
          "font-heading font-bold tracking-tight",
          !svg && "text-primary",
          textClassName,
        )}
      >
        KaiBot
      </span>
    </span>
  ) : (
    img
  );

  if (href) {
    return (
      <a href={href} className="inline-flex items-center">
        {content}
      </a>
    );
  }
  return content;
}
