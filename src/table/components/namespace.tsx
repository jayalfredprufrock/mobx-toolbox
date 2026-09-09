import { TableResizer } from "./column-resizer";
import { SelectAll, SelectionCell, SelectionHeaderCell } from "./selection";
import { TableBody, TableCell, TableRow } from "./table-body";
import { TableEmpty } from "./table-empty";
import { TableError } from "./table-error";
import { TableGutter } from "./table-gutter";
import { TableColumnHeader, TableHeader } from "./table-header";
import { TableLoading } from "./table-loading";
import { TableOverlay } from "./table-overlay";
import { TableExpansion } from "./table-expansion";
import { TableRoot } from "./table-root";
import { TableScroll } from "./table-scroll";
import { TableStatusBar } from "./table-status-bar";

/**
 * Compound namespace for the table skeleton. Consumers compose these into their own closed
 * component (styles + defaults captured once), e.g.
 * `<Table.Root><Table.Scroll><Table.Header>…`.
 *
 * Two boxes, and which one a part goes in is the whole structure: `Root` is the outer frame,
 * `Scroll` is the box that overflows. Header, body, rows and the overlay surfaces go inside
 * `Scroll`; chrome that must sit outside the scrollbars — `StatusBar`, a toolbar, pagination —
 * goes directly in `Root`.
 */
export const Table = {
  Root: TableRoot,
  Scroll: TableScroll,
  Header: TableHeader,
  ColumnHeader: TableColumnHeader,
  Body: TableBody,
  Row: TableRow,
  Cell: TableCell,
  Empty: TableEmpty,
  Loading: TableLoading,
  Error: TableError,
  Gutter: TableGutter,
  StatusBar: TableStatusBar,
  Overlay: TableOverlay,
  Expansion: TableExpansion,
  Resizer: TableResizer,
  SelectionCell: SelectionCell,
  SelectionHeaderCell: SelectionHeaderCell,
  SelectAll: SelectAll,
};
