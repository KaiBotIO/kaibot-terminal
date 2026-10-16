import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  /** Trigger label shown when nothing is picked (e.g. "Status"). */
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  className?: string;
  /** Show the type-to-filter box. Defaults on when there are many options. */
  searchable?: boolean;
}

/**
 * Checkbox multi-select in a popover, for table filters that should accept
 * several values at once (status, symbol, strategy…). Pairs with
 * `useUrlTableState`'s `setFilterValues` so the picks live in the URL. Reusable
 * across any list built on the DataMatrix pattern.
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  className,
  searchable,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const showSearch = searchable ?? options.length > 8;
  const selectedSet = new Set(selected);
  const count = selected.length;

  const toggle = (value: string) => {
    if (selectedSet.has(value)) onChange(selected.filter((v) => v !== value));
    else onChange([...selected, value]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 justify-between gap-1.5 text-xs", className)}
        >
          <span className={count > 0 ? "text-foreground" : "text-muted-foreground"}>
            {label}
          </span>
          {count > 0 && (
            <Badge
              variant="secondary"
              className="h-4 rounded-none px-1 font-mono text-[10px] tabular-nums"
            >
              {count}
            </Badge>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[220px] p-0" align="start">
        <Command>
          {showSearch && (
            <CommandInput
              placeholder={`Filter ${label.toLowerCase()}…`}
              className="text-xs"
            />
          )}
          <CommandList>
            <CommandEmpty>No matches</CommandEmpty>
            {options.map((o) => {
              const active = selectedSet.has(o.value);
              return (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => toggle(o.value)}
                  className="gap-2 text-xs"
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center border",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input",
                    )}
                  >
                    {active && <Check className="size-3" />}
                  </span>
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              );
            })}
          </CommandList>
          {count > 0 && (
            <div className="border-t border-border/60 p-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-full text-xs"
                onClick={() => onChange([])}
              >
                Clear {label.toLowerCase()}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
