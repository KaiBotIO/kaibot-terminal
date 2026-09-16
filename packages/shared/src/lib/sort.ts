import { useCallback, useMemo, useState } from "react";

export type SortVal = string | number | null | undefined;
export type SortDir = "asc" | "desc";

export interface SortState {
  key: string;
  dir: SortDir;
}

/** Numbers compared numerically, else locale strings; null/undefined/NaN sort last. */
export function compareVals(a: SortVal, b: SortVal): number {
  const aEmpty = a == null || (typeof a === "number" && Number.isNaN(a));
  const bEmpty = b == null || (typeof b === "number" && Number.isNaN(b));
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1; // empties last
  if (bEmpty) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** Stable-ish sorted copy; empties stay last in BOTH directions. */
export function sortRows<T>(rows: T[], accessor: (row: T) => SortVal, dir: SortDir): T[] {
  const m = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    const aEmpty = av == null || (typeof av === "number" && Number.isNaN(av));
    const bEmpty = bv == null || (typeof bv === "number" && Number.isNaN(bv));
    if (aEmpty || bEmpty) return compareVals(av, bv);
    return m * compareVals(av, bv);
  });
}

export interface UseTableSortResult<T> {
  rows: T[];
  sort: SortState | null;
  toggleSort: (key: string) => void;
  setSort: (sort: SortState | null) => void;
}

/** Sort state + sorted rows for raw <Table> consumers (DataMatrix has its own). */
export function useTableSort<T>(
  rows: T[],
  accessors: Record<string, (row: T) => SortVal>,
  defaultSort?: SortState,
): UseTableSortResult<T> {
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const acc = accessors[sort.key];
    if (!acc) return rows;
    return sortRows(rows, acc, sort.dir);
  }, [rows, accessors, sort]);

  const toggleSort = useCallback(
    (key: string) =>
      setSort((prev) =>
        prev?.key === key
          ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { key, dir: "asc" },
      ),
    [],
  );

  return { rows: sorted, sort, toggleSort, setSort };
}
