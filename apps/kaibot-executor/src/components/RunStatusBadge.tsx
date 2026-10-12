import { Badge } from "@kaibot/shared";
import { statusVariant } from "@/lib/bot-status";

export function RunStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariant(status)} className="text-[10px] py-0 px-1.5">
      {status}
    </Badge>
  );
}
