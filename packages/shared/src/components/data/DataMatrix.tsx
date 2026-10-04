import {
  Fragment,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronRight, Info } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { compareVals } from "../../lib/sort";
import { useSessionState } from "../../hooks/useSessionState";

export interface MatrixColumn<T> {
  key: string;
  header: ReactNode;
  /** Right-align numeric columns (also enables tabular-nums). */
  align?: "left" | "right";
  cell: (row: T, index: number) => ReactNode;
  /** Extra class on the <td>. */
  className?: string;
  headClassName?: string;
  /** Plain-language explanation, shown as an info tooltip next to the header. */
  hint?: string;
  /** Make the column header clickable to sort. Requires `sortAccessor`. */
  sortable?: boolean;
  /** The comparable value for sorting (numbers compared numerically, else by
   *  locale string). null/undefined sort last regardless of direction. */
  sortAccessor?: (row: T) => string | number | null | undefined;
  /**
   * Pin this column to the right edge while the table scrolls horizontally.
   * Mark the trailing (rightmost) columns you always want visible; their
   * offsets stack automatically so several can be pinned side by side.
   */
  sticky?: boolean;
}

export interface MatrixSort {
  key: string;
  dir: "asc" | "desc";
}

/** Keys that activate a control the way a native button does. */
const ROW_ACTIVATION_KEYS = ["Enter", " "];

export interface RowInteraction {
  tabIndex?: 0;
  onClick?: () => void;
  onKeyDown?: (e: { key: string; preventDefault: () => void }) => void;
}

/**
 * Interactive props for a matrix row. With `onRowClick` the row joins the tab
 * order and fires on Enter/Space; without it the row gets nothing, so
 * non-navigating tables keep their rows out of the tab order.
 *
 * No role override: a `role="button"` <tr> drops out of the table's a11y tree,
 * taking its row/cell semantics with it, and rows may contain real buttons.
 */
export function rowInteractionProps<T>(
  onRowClick: ((row: T, index: number) => void) | undefined,
  row: T,
  index: number,
): RowInteraction {
  if (!onRowClick) return {};
  return {
    tabIndex: 0,
    onClick: () => onRowClick(row, index),
    onKeyDown: (e) => {
      if (!ROW_ACTIVATION_KEYS.includes(e.key)) return;
      e.preventDefault();
      onRowClick(row, index);
    },
  };
}

export interface MatrixExpandable<T> {
  /** Detail block rendered full-width under an expanded row. */
  render: (row: T, index: number) => ReactNode;
  /** Limit which rows offer expansion (default: every row). */
  isExpandable?: (row: T) => boolean;
}

export interface MatrixGroup<T> {
  /**
   * Group id + header label for a row. Rows sharing an id bucket together. The
   * already-sorted rows are bucketed in encounter order, so groups appear
   * ordered by their best row under the active sort (across-group sort) and each
   * group's rows keep the active sort (within-group sort).
   */
  by: (row: T) => { key: string; label: ReactNode };
  /** Right-aligned summary in the group header (e.g. count + avg return). */
  summary?: (rows: T[]) => ReactNode;
}

interface DataMatrixProps<T> {
  columns: MatrixColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Router-agnostic row navigation (use `navigate(...)` from the page). */
  onRowClick?: (row: T, index: number) => void;
  /** Full-width node rendered when there are no rows. */
  empty?: ReactNode;
  className?: string;
  /** Initial sort (uncontrolled). Omit for the original (unsorted) order. */
  defaultSort?: { key: string; dir: "asc" | "desc" };
  /**
   * Persist the active sort across unmount/remount under this key (sessionStorage),
   * so navigating into a detail route and back keeps the chosen sort instead of
   * snapping to `defaultSort`. Use a stable, unique key per table.
   */
  persistKey?: string;
  /**
   * Controlled sort. Pass `sort` + `onSortToggle` to drive sorting from the
   * caller (e.g. server-side sort over a paginated query). In controlled mode
   * the matrix renders `rows` in the given order untouched and only reports
   * header clicks — `defaultSort`/`persistKey`/`sortAccessor` are ignored.
   */
  sort?: MatrixSort | null;
  onSortToggle?: (key: string) => void;
  /**
   * Expandable rows: adds a leading chevron column; toggling reveals
   * `render(row)` in a full-width detail row. Combine with `onRowClick` only
   * when the click targets differ (the chevron stays its own button).
   */
  expandable?: MatrixExpandable<T>;
  /**
   * Group rows under collapsible headers (e.g. by strategy). Works with the
   * active sort: groups order by their best row, rows sort within the group.
   */
  group?: MatrixGroup<T>;
}

/**
 * Canonical Gridline Tokyo hairline matrix (22a `.wtable`): 9px mono-caps
 * headers, 13px tabular rows on faint hairlines, 24px edge gutters, row hover.
 * Drop it inside a `<Section flush>` so the section frames it. Router-agnostic
 * — pass `onRowClick` for navigation rather than baking in <Link>.
 *
 * Sorting: mark a column `sortable` + give it a `sortAccessor`; the header
 * becomes a click target that cycles asc → desc. Sorting is self-contained
 * (uncontrolled); filtering stays the caller's job (pass already-filtered rows).
 * Pass `persistKey` on any table that navigates into a detail route so the sort
 * survives the round-trip instead of resetting on remount.
 */
export function DataMatrix<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  className,
  defaultSort,
  persistKey,
  sort: controlledSort,
  onSortToggle,
  expandable,
  group,
}: DataMatrixProps<T>) {
  const clickable = !!onRowClick;
  const controlled = !!onSortToggle;
  const [internalSort, setInternalSort] = useSessionState<MatrixSort | null>(
    persistKey ? `datamatrix-sort:${persistKey}` : null,
    defaultSort ?? null,
  );
  const sort = controlled ? controlledSort ?? null : internalSort;
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Sticky right-pinned columns: measure each pinned header cell so the columns
  // stack against the right edge at their real widths (they're nowrap, so widths
  // aren't known up front). Recompute on resize.
  const stickyKeys = useMemo(
    () => columns.filter((c) => c.sticky).map((c) => c.key),
    [columns],
  );
  const stickyKeyStr = stickyKeys.join(",");
  const tableRef = useRef<HTMLTableElement>(null);
  const headCellRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const [stickyOffsets, setStickyOffsets] = useState<Record<string, number>>({});
  const firstStickyKey = stickyKeys[0];

  useLayoutEffect(() => {
    if (stickyKeys.length === 0) {
      setStickyOffsets((prev) => (Object.keys(prev).length ? {} : prev));
      return;
    }
    const measure = () => {
      const next: Record<string, number> = {};
      let acc = 0;
      // Right to left: each pinned column sits past the ones to its right.
      for (let i = stickyKeys.length - 1; i >= 0; i--) {
        const key = stickyKeys[i];
        next[key] = acc;
        acc += headCellRefs.current.get(key)?.offsetWidth ?? 0;
      }
      setStickyOffsets((prev) => {
        const same = stickyKeys.every((k) => prev[k] === next[k]);
        return same ? prev : next;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (tableRef.current) ro.observe(tableRef.current);
    for (const k of stickyKeys) {
      const el = headCellRefs.current.get(k);
      if (el) ro.observe(el);
    }
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickyKeyStr, columns.length, rows.length]);
  const toggleExpanded = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const colCount = columns.length + (expandable ? 1 : 0);

  const sortedRows = useMemo(() => {
    // Controlled mode: the caller already ordered the rows (server-side sort).
    if (controlled || !sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortAccessor) return rows;
    const acc = col.sortAccessor;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => dir * compareVals(acc(a), acc(b)));
  }, [rows, columns, sort, controlled]);

  // Bucket the (already sorted) rows into groups, in encounter order. Because
  // sortedRows is globally sorted, a group first appears at its best row, so
  // groups end up ordered by their best row and each keeps its rows sorted.
  const groups = useMemo(() => {
    if (!group) return null;
    const map = new Map<string, { label: ReactNode; rows: T[] }>();
    for (const row of sortedRows) {
      const { key, label } = group.by(row);
      const bucket = map.get(key);
      if (bucket) bucket.rows.push(row);
      else map.set(key, { label, rows: [row] });
    }
    return [...map.entries()].map(([key, v]) => ({ key, ...v }));
  }, [group, sortedRows]);

  const toggleSort = (key: string) => {
    if (controlled) {
      onSortToggle!(key);
      return;
    }
    setInternalSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" },
    );
  };

  const stickyEdgeClass = (c: MatrixColumn<T>) =>
    c.sticky && c.key === firstStickyKey ? "border-l border-border/60" : undefined;
  const stickyStyle = (c: MatrixColumn<T>) =>
    c.sticky ? { right: stickyOffsets[c.key] ?? 0 } : undefined;

  const renderRow = (row: T, i: number) => {
    const key = rowKey(row, i);
    const canExpand = !!expandable && (expandable.isExpandable?.(row) ?? true);
    const isExpanded = canExpand && expandedKeys.has(key);
    return (
      <Fragment key={key}>
        <tr
          {...rowInteractionProps(onRowClick, row, i)}
          className={cn(
            "group border-b border-border/60 transition-colors last:border-b-0",
            isExpanded && "border-b-0 bg-card/50",
            clickable &&
              "cursor-pointer outline-none hover:bg-card focus-visible:bg-card focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-ring",
          )}
        >
          {expandable && (
            <td className="w-8 py-3 pl-6 pr-0 align-middle">
              {canExpand && (
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "Collapse row details" : "Expand row details"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpanded(key);
                  }}
                  className="flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                >
                  <ChevronRight
                    className={cn(
                      "size-3.5 transition-transform",
                      isExpanded && "rotate-90",
                    )}
                  />
                </button>
              )}
            </td>
          )}
          {columns.map((c, ci) => (
            <td
              key={c.key}
              style={stickyStyle(c)}
              className={cn(
                "whitespace-nowrap px-3 py-3 align-middle text-[13px] last:pr-6",
                !expandable && ci === 0 && "pl-6",
                c.align === "right" ? "text-right tabular-nums" : "text-left",
                c.sticky &&
                  cn(
                    "sticky z-10 bg-background group-hover:bg-card",
                    isExpanded && "bg-card/50",
                    clickable && "group-focus-visible:bg-card",
                  ),
                stickyEdgeClass(c),
                c.className,
              )}
            >
              {c.cell(row, i)}
            </td>
          ))}
        </tr>
        {isExpanded && (
          <tr className="border-b border-border/60 bg-card/50 last:border-b-0">
            <td colSpan={colCount} className="px-6 pb-3 pt-0">
              {expandable!.render(row, i)}
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  // Global index per row so grouped rendering keeps correct cell/onClick indices.
  let cursor = 0;

  return (
    <TooltipProvider>
    <div className={cn("w-full max-w-full overflow-x-auto", className)}>
      <table ref={tableRef} className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border/60">
            {expandable && <th aria-hidden className="w-8 pl-6 pr-0" />}
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const caret = !c.sortable
                ? null
                : active
                  ? sort!.dir === "asc"
                    ? " ↑"
                    : " ↓"
                  : " ↕";
              return (
                <th
                  key={c.key}
                  ref={(el) => {
                    if (el) headCellRefs.current.set(c.key, el);
                    else headCellRefs.current.delete(c.key);
                  }}
                  aria-sort={
                    active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined
                  }
                  style={stickyStyle(c)}
                  className={cn(
                    "whitespace-nowrap px-3 py-2.5 font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground first:pl-6 last:pr-6",
                    c.align === "right" ? "text-right" : "text-left",
                    c.sticky && "sticky z-20 bg-background",
                    stickyEdgeClass(c),
                    c.headClassName,
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex items-center gap-1",
                      c.align === "right" && "flex-row-reverse",
                    )}
                  >
                    {c.sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={cn(
                          "inline-flex items-center font-mono text-[9px] font-medium uppercase tracking-[0.12em] transition-colors hover:text-foreground",
                          active ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {c.header}
                        <span className={cn("ml-0.5", active ? "opacity-100" : "opacity-40")}>
                          {caret}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                    {c.hint && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={`About ${typeof c.header === "string" ? c.header : c.key}`}
                            className="text-muted-foreground/60 hover:text-foreground"
                          >
                            <Info className="size-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs whitespace-pre-line normal-case tracking-normal">
                          {c.hint}
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 && empty != null && (
            <tr>
              <td colSpan={colCount} className="px-6">
                {empty}
              </td>
            </tr>
          )}
          {groups
            ? groups.map((g) => {
                const collapsed = collapsedGroups.has(g.key);
                return (
                  <Fragment key={`__group__${g.key}`}>
                    <tr
                      className="border-b border-border/60 bg-card/40 transition-colors hover:bg-card/60"
                    >
                      <td colSpan={colCount} className="p-0">
                        <button
                          type="button"
                          aria-expanded={!collapsed}
                          onClick={() => toggleGroup(g.key)}
                          className="flex w-full items-center gap-2 px-6 py-2 text-left"
                        >
                          <ChevronRight
                            className={cn(
                              "size-3.5 shrink-0 text-muted-foreground transition-transform",
                              !collapsed && "rotate-90",
                            )}
                          />
                          <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-foreground">
                            {g.label}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {g.rows.length}
                          </span>
                          {group!.summary && (
                            <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                              {group!.summary(g.rows)}
                            </span>
                          )}
                        </button>
                      </td>
                    </tr>
                    {!collapsed && g.rows.map((row) => renderRow(row, cursor++))}
                  </Fragment>
                );
              })
            : sortedRows.map((row, i) => renderRow(row, i))}
        </tbody>
      </table>
    </div>
    </TooltipProvider>
  );
}
