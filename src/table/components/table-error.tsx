import { observer } from "mobx-react-lite";
import type { FC, ReactNode } from "react";
import { useTableContext } from "../table.context";
import { TableOverlay, type TableOverlayProps } from "./table-overlay";

// `children` is widened to a render prop, which HTMLAttributes' own ReactNode-only
// declaration would otherwise forbid.
export interface TableErrorProps extends Omit<TableOverlayProps, "children"> {
  /**
   * What to say about the failure. A function is called with whatever the source failed with, so a
   * message can be derived from it without reaching back into the model:
   *
   * ```tsx
   * <Table.Error>{(error) => (error instanceof HttpError ? error.status : "Something went wrong")}</Table.Error>
   * ```
   */
  children?: ReactNode | ((error: unknown) => ReactNode);
}

/**
 * The failure surface. Render it after `<Table.Body>` alongside `<Table.Empty>` and
 * `<Table.Loading>`; it shows itself only when the request failed and left nothing to show for it.
 *
 * **A failed *refresh* does not render this**, and that is the whole point of the gate. Rows
 * already on screen are still perfectly good rows, and blanking a working table because a
 * background request came back 500 destroys scroll position, column arrangement and selection over
 * something the user never asked for. The table says nothing at all about that case; the error is
 * still on your lazy, or still in the prop you passed, and belongs on a refresh control or in a
 * toast — somewhere that isn't the rows.
 *
 * The three slots are mutually exclusive by construction, so ordering them is not your problem:
 * `loading` excludes a failure, `isEmpty` excludes both, and this renders only for the failure
 * with nothing behind it.
 *
 * Needs the table to have been told about the failure: a `RowSource` that carries an `error`, or
 * an `error` prop passed to `useTable` alongside a plain array. If the error isn't about the
 * dataset at all, `<Table.Overlay>` gives you the same surface with no gate.
 *
 * Owns placement only — cosmetics are the consumer's, and `data-error` is the styling hook.
 */
export const TableError: FC<TableErrorProps> = observer(({ children, ...rest }) => {
  const table = useTableContext();
  const error = table.error;
  if (error === undefined) return null;
  return (
    <TableOverlay data-error="" {...rest}>
      {typeof children === "function" ? children(error) : children}
    </TableOverlay>
  );
});
