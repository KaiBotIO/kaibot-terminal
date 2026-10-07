import type { GroupFilterChip } from "@/lib/position-protection";

export function GroupFilterChips({
  chips,
  active,
  onChange,
}: {
  chips: GroupFilterChip[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.key)}
          aria-pressed={active === c.key}
          className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
            active === c.key
              ? "border-primary/60 text-foreground"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          {c.label} <span className="tabular-nums text-muted-foreground">{c.count}</span>
        </button>
      ))}
    </>
  );
}
