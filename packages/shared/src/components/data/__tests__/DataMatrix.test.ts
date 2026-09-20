import { describe, expect, it, mock } from "bun:test";
import { rowInteractionProps } from "../DataMatrix";

interface Row {
  id: string;
}

const row: Row = { id: "r1" };

describe("rowInteractionProps", () => {
  it("returns nothing when the table has no onRowClick (rows stay non-focusable)", () => {
    const props = rowInteractionProps<Row>(undefined, row, 0);
    expect(props.tabIndex).toBeUndefined();
    expect(props.onClick).toBeUndefined();
    expect(props.onKeyDown).toBeUndefined();
  });

  it("puts a clickable row in the tab order", () => {
    const props = rowInteractionProps<Row>(() => {}, row, 0);
    expect(props.tabIndex).toBe(0);
  });

  // A role="button" <tr> drops out of the table's a11y tree and swallows the
  // row/cell semantics — rows stay rows.
  it("does not override the row's implicit table role", () => {
    expect("role" in rowInteractionProps<Row>(() => {}, row, 0)).toBe(false);
  });

  it("fires onRowClick on click with the row and index", () => {
    const onRowClick = mock((_r: Row, _i: number) => {});
    rowInteractionProps<Row>(onRowClick, row, 3).onClick?.();
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith(row, 3);
  });

  it("activates on Enter and Space, calling preventDefault", () => {
    for (const key of ["Enter", " "]) {
      const onRowClick = mock((_r: Row, _i: number) => {});
      const preventDefault = mock(() => {});
      rowInteractionProps<Row>(onRowClick, row, 2).onKeyDown?.({ key, preventDefault });
      expect(onRowClick).toHaveBeenCalledWith(row, 2);
      expect(preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores other keys and does not swallow their default", () => {
    const onRowClick = mock((_r: Row, _i: number) => {});
    const preventDefault = mock(() => {});
    rowInteractionProps<Row>(onRowClick, row, 0).onKeyDown?.({ key: "Tab", preventDefault });
    expect(onRowClick).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
