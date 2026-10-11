import { Button, DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Input, Switch } from "@kaibot/shared";
import { ChevronDown, X } from "@/lib/icons";

export type Direction = "both" | "long" | "short";

export interface AnalyticsFilterState {
  accounts: string[];
  strategies: string[];
  symbols: string[];
  direction: Direction;
  /** Calendar day, YYYY-MM-DD, read in the viewer's own zone. */
  from: string | null;
  to: string | null;
  includeNonBot: boolean;
}

export interface AnalyticsFilterOptions {
  accounts: string[];
  strategies: { key: string; label: string }[];
  symbols: string[];
}

export const EMPTY_FILTER: AnalyticsFilterState = {
  accounts: [],
  strategies: [],
  symbols: [],
  direction: "both",
  from: null,
  to: null,
  includeNonBot: true,
};

export function isFilterActive(f: AnalyticsFilterState): boolean {
  return (
    f.accounts.length > 0 ||
    f.strategies.length > 0 ||
    f.symbols.length > 0 ||
    f.direction !== "both" ||
    f.from != null ||
    f.to != null ||
    !f.includeNonBot
  );
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** "All accounts" / "21084933" / "2 accounts" */
function summarise(selected: string[], labelOf: (v: string) => string, all: string, plural: string) {
  if (selected.length === 0) return all;
  if (selected.length === 1) return labelOf(selected[0]);
  return `${selected.length} ${plural}`;
}

function MultiSelect({
  label,
  all,
  plural,
  options,
  selected,
  onChange,
}: {
  label: string;
  all: string;
  plural: string;
  options: { key: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const labelOf = (key: string) => options.find((o) => o.key === key)?.label ?? key;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={options.length === 0}
          className="h-7 gap-1 px-2 font-mono text-[11px] normal-case tracking-normal"
        >
          <span className="text-muted-foreground">{label}</span>
          <span className={selected.length > 0 ? "text-[var(--kb-teal)]" : ""}>
            {summarise(selected, labelOf, all, plural)}
          </span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
        <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-wider">
          {label}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.key}
            checked={selected.includes(o.key)}
            onCheckedChange={() => onChange(toggle(selected, o.key))}
            onSelect={(e) => e.preventDefault()}
            className="font-mono text-xs"
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
        {selected.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full px-2 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "both", label: "Both" },
  { value: "long", label: "Long" },
  { value: "short", label: "Short" },
];

export function AnalyticsFilterBar({
  value,
  options,
  onChange,
  onReset,
}: {
  value: AnalyticsFilterState;
  options: AnalyticsFilterOptions;
  onChange: (next: AnalyticsFilterState) => void;
  onReset: () => void;
}) {
  const set = <K extends keyof AnalyticsFilterState>(key: K, v: AnalyticsFilterState[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-2">
      <MultiSelect
        label="Account"
        all="All"
        plural="accounts"
        options={options.accounts.map((a) => ({ key: a, label: a }))}
        selected={value.accounts}
        onChange={(v) => set("accounts", v)}
      />
      <MultiSelect
        label="Strategy"
        all="All"
        plural="strategies"
        options={options.strategies}
        selected={value.strategies}
        onChange={(v) => set("strategies", v)}
      />
      <MultiSelect
        label="Market"
        all="All"
        plural="markets"
        options={options.symbols.map((s) => ({ key: s, label: s }))}
        selected={value.symbols}
        onChange={(v) => set("symbols", v)}
      />

      <div className="flex items-center border border-border">
        {DIRECTIONS.map((d) => (
          <button
            key={d.value}
            type="button"
            onClick={() => set("direction", d.value)}
            className={`h-7 px-2 font-mono text-[11px] transition-colors ${
              value.direction === d.value
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <Input
          type="date"
          aria-label="From"
          value={value.from ?? ""}
          max={value.to ?? undefined}
          onChange={(e) => set("from", e.target.value || null)}
          className="h-7 w-[8.5rem] px-2 font-mono text-[11px]"
        />
        <span className="font-mono text-[11px] text-muted-foreground">to</span>
        <Input
          type="date"
          aria-label="To"
          value={value.to ?? ""}
          min={value.from ?? undefined}
          onChange={(e) => set("to", e.target.value || null)}
          className="h-7 w-[8.5rem] px-2 font-mono text-[11px]"
        />
      </div>

      <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
        <Switch
          checked={value.includeNonBot}
          onCheckedChange={(v) => set("includeNonBot", v)}
          aria-label="Include manual and repair posts"
        />
        Manual &amp; repair posts
      </label>

      {isFilterActive(value) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onReset}
          className="h-7 gap-1 px-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
        >
          <X className="size-3" />
          Reset
        </Button>
      )}
    </div>
  );
}
