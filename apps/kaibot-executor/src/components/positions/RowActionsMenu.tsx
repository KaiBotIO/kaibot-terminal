import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@kaibot/shared";
import { Check, Loader2, MoreHorizontal } from "@/lib/icons";
import type { RowActionId } from "@/lib/position-protection";

export interface RowActionHandlers {
  onAction: (id: Exclude<RowActionId, "move" | "reduce">) => void;
  onReduce: (fraction: number) => void;
  onMove: (groupId: string | null) => void;
  onNewGroup: () => void;
}

const LABEL: Record<Exclude<RowActionId, "move" | "reduce">, string> = {
  "manage-stop": "Set stop…",
  "hand-over": "Hand over to a ride bot…",
  "take-back": "Take back from the ride bot",
  adopt: "Adopt into bot…",
  accumulate: "Accumulate…",
  roll: "Roll to next contract…",
  "plan-check": "Plan: check now",
  "plan-stop": "Plan: stop, cancel rungs",
  close: "Close at market",
};

// Section breaks: after the protection actions, before the plan, before closing.
const BREAK_BEFORE = new Set<RowActionId>(["move", "plan-check", "reduce"]);

const item = "cursor-pointer font-mono text-xs";

export function RowActionsMenu({
  ids,
  groups,
  currentGroupId,
  busy,
  disabled,
  defaultOpen,
  handlers,
}: {
  ids: RowActionId[];
  groups: Array<{ id: string; name: string }>;
  currentGroupId: string | null;
  busy?: boolean;
  disabled?: boolean;
  defaultOpen?: boolean;
  handlers: RowActionHandlers;
}) {
  if (ids.length === 0) return null;
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 w-7 px-0"
          disabled={disabled}
          aria-label="Position actions"
          onClick={(e) => e.stopPropagation()}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <MoreHorizontal className="size-3.5" />}
        </Button>
      </DropdownMenuTrigger>
      {/* React events bubble through the portal to the row; stop them here. */}
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {ids.map((id, i) => {
          const sep = i > 0 && BREAK_BEFORE.has(id) ? <DropdownMenuSeparator key={`sep-${id}`} /> : null;
          if (id === "move") {
            return [
              sep,
              <DropdownMenuSub key={id}>
                <DropdownMenuSubTrigger className={item}>Move to group</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem className={item} onClick={() => handlers.onMove(null)}>
                    {currentGroupId == null && <Check className="mr-1 size-3" />}
                    Manual
                  </DropdownMenuItem>
                  {groups.map((g) => (
                    <DropdownMenuItem key={g.id} className={item} onClick={() => handlers.onMove(g.id)}>
                      {currentGroupId === g.id && <Check className="mr-1 size-3" />}
                      {g.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className={item} onClick={handlers.onNewGroup}>
                    New group…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>,
            ];
          }
          if (id === "reduce") {
            return [
              sep,
              <DropdownMenuSub key={id}>
                <DropdownMenuSubTrigger className={item}>Reduce</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {[0.25, 0.5, 0.75].map((f) => (
                    <DropdownMenuItem key={f} className={item} onClick={() => handlers.onReduce(f)}>
                      {f * 100}%
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>,
            ];
          }
          const danger = id === "close" || id === "plan-stop";
          return [
            sep,
            <DropdownMenuItem
              key={id}
              data-action={id}
              className={`${item} ${danger ? "text-[var(--kb-red)] focus:text-[var(--kb-red)]" : ""}`}
              onClick={() => handlers.onAction(id)}
            >
              {LABEL[id]}
            </DropdownMenuItem>,
          ];
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
