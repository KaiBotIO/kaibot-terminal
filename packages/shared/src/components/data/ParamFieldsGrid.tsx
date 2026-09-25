import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "../ui";

// Param descriptor returned by backtester.describeStrategyKind (mirrors the
// SDK's ParamField). Array params (e.g. ladderMinutes) carry `isArray` and are
// edited as a comma-separated list. Shared by every SDK param surface
// (frontend authoring form, live-as-bot dialog, admin system-strategy editor)
// so there is exactly one place that knows how to render a ParamField.
export interface ParamField {
  name: string;
  type: "number" | "string" | "boolean" | "enum";
  label: string;
  required: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  int?: boolean;
  isArray?: boolean;
  options?: string[];
  description?: string;
}

export type FormValue = string | number | boolean;

export const isArrayField = (f: ParamField): boolean =>
  f.isArray === true || Array.isArray(f.default);

// Seed a field's initial form value from a config object, falling back to the
// field's own default.
export function seedValue(
  f: ParamField,
  initial: Record<string, unknown> | undefined,
): FormValue {
  const fromInitial = initial?.[f.name];
  const raw = fromInitial !== undefined ? fromInitial : f.default;
  if (isArrayField(f)) {
    return Array.isArray(raw) ? raw.join(", ") : "";
  }
  if (raw !== undefined && raw !== null) return raw as FormValue;
  // Optional, no default: leave empty so it is omitted (e.g. maxUpgradeLevel).
  if (f.type === "boolean") return false;
  if (f.type === "enum") return f.options?.[0] ?? "";
  return "";
}

export function parseCsvNumbers(s: string): number[] {
  return s
    .split(/[,\s]+/)
    .map((t) => Number(t.trim()))
    .filter((n) => Number.isFinite(n));
}

// Turn the form's per-field values back into a plugin config object, applying
// the same coercions the plugin schema expects (numbers, booleans, CSV arrays).
export function buildConfigFromValues(
  fields: ParamField[],
  values: Record<string, FormValue>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (isArrayField(f)) {
      const arr = parseCsvNumbers(String(v ?? ""));
      if (arr.length) config[f.name] = arr;
      else if (Array.isArray(f.default) && f.default.length) {
        // Empty input → keep the plugin's default array rather than silently
        // omitting it (which would flip to a different preset ladder).
        config[f.name] = f.default;
      }
    } else if (f.type === "boolean") {
      config[f.name] = v === true;
    } else if (f.type === "number") {
      // Omit empty optional numbers (e.g. maxUpgradeLevel → plugin default).
      if (v !== "" && v != null && Number.isFinite(Number(v))) {
        config[f.name] = Number(v);
      }
    } else if (v != null && v !== "") {
      config[f.name] = v;
    }
  }
  return config;
}

interface GridProps {
  fields: ParamField[];
  values: Record<string, FormValue>;
  onChange: (name: string, value: FormValue) => void;
  // Word appended to the array-field hint, e.g. "(comma-separated minutes)".
  // Empty string omits the unit word, leaving just "(comma-separated)".
  arrayUnitLabel?: string;
}

// The param grid: one control per field, laid out 2-up.
export function ParamFieldsGrid({
  fields,
  values,
  onChange,
  arrayUnitLabel = "minutes",
}: GridProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {fields.map((f) => {
        const value = values[f.name];
        const isArr = isArrayField(f);

        if (f.type === "boolean") {
          return (
            <div
              key={f.name}
              className="col-span-2 flex items-center justify-between gap-2"
            >
              <Label className="text-xs" title={f.description}>
                {f.label}
              </Label>
              <Switch
                checked={value === true}
                onCheckedChange={(c) => onChange(f.name, c)}
              />
            </div>
          );
        }

        if (f.type === "enum" && !isArr) {
          return (
            <div key={f.name} className="space-y-1.5">
              <Label className="text-xs" title={f.description}>
                {f.label}
              </Label>
              <Select
                value={String(value ?? "")}
                onValueChange={(v) => onChange(f.name, v)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(f.options ?? []).map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        }

        if (f.type === "number" && !isArr) {
          return (
            <div key={f.name} className="space-y-1.5">
              <Label className="text-xs" title={f.description}>
                {f.label}
              </Label>
              <Input
                type="number"
                step={f.int ? "1" : "any"}
                min={f.min}
                max={f.max}
                value={value == null ? "" : String(value)}
                placeholder={f.required ? "" : "default"}
                onChange={(e) => onChange(f.name, e.target.value)}
              />
            </div>
          );
        }

        // Array (CSV) or plain string.
        return (
          <div key={f.name} className="col-span-2 space-y-1.5">
            <Label className="text-xs" title={f.description}>
              {f.label}
              {isArr
                ? ` (comma-separated${arrayUnitLabel ? ` ${arrayUnitLabel}` : ""})`
                : ""}
            </Label>
            <Input
              // Union params (e.g. confirmProgress boolean|number) seed a
              // non-string value into a string field — render it instead of
              // hiding the active setting behind an empty box.
              value={value == null ? "" : String(value)}
              placeholder={isArr ? "15, 30, 45, 60, 120" : ""}
              onChange={(e) => onChange(f.name, e.target.value)}
            />
          </div>
        );
      })}
    </div>
  );
}
