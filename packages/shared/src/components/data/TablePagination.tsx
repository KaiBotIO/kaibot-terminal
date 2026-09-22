import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface TablePaginationProps {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  /** Total rows across every page (matching the active filters). */
  total: number;
  onPageChange: (page: number) => void;
  className?: string;
}

/**
 * Pager for the sticky DataMatrix + server-side pagination pattern. Shows the
 * visible row range over the filtered total and steps a page at a time. Hidden
 * when everything fits on one page. Pair with `useUrlTableState` so the page
 * lives in the URL.
 *
 * For focus-safe, flicker-free paging, give the backing query
 * `placeholderData: keepPreviousData` — otherwise a page change drops the query
 * data and unmounts the table + filter inputs (losing search-input focus).
 */
export function TablePagination({
  page,
  pageSize,
  total,
  onPageChange,
  className,
}: TablePaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0 || pageCount <= 1) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-t border-border/60 px-6 py-3",
        className,
      )}
    >
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          Page {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
