import { TableResizer } from "./column-resizer";
import { SelectAll, SelectionCell, SelectionHeaderCell } from "./selection";
import { TableBody, TableCell, TableRow } from "./table-body";
import { TableEmpty } from "./table-empty";
import { TableError } from "./table-error";
import { TableLoading } from "./table-loading";
import { TableOverlay } from "./table-overlay";
import { TableExpansion } from "./table-expansion";
import { TableColumnHeader, TableHeader } from "./table-header";
import { TableRoot } from "./table-root";

/**
 * Compound namespace for the table skeleton. Consumers compose these into their own closed
 * component (styles + defaults captured once), e.g. `<Table.Root><Table.Header>…`.
 */
export const Table = {
  Root: TableRoot,
  Header: TableHeader,
  ColumnHeader: TableColumnHeader,
  Body: TableBody,
  Row: TableRow,
  Cell: TableCell,
  Empty: TableEmpty,
  Loading: TableLoading,
  Error: TableError,
  Overlay: TableOverlay,
  Expansion: TableExpansion,
  Resizer: TableResizer,
  SelectionCell: SelectionCell,
  SelectionHeaderCell: SelectionHeaderCell,
  SelectAll: SelectAll,
};
