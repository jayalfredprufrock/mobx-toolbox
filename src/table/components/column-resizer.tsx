import { observer } from "mobx-react-lite";
import { type CSSProperties, type FC, useEffect, useRef, useState } from "react";
import type { ColumnModel } from "../column.model";

export interface TableResizerProps {
  column: ColumnModel;
}

/**
 * Drag handle on a header cell's edge that resizes its column. Dragging sets the column's
 * `manualWidth` (treated as a fixed width in the distribution, so the remaining flex columns reflow
 * to fill); double-click resets it to auto. Right-pinned columns are anchored to the right, so their
 * handle sits on the left edge and the drag delta is inverted.
 *
 * Move/up listeners live on the window for the duration of the drag, so the resize tracks and ends
 * wherever the pointer is released — not only over the handle.
 */
export const TableResizer: FC<TableResizerProps> = observer(({ column }) => {
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const raf = useRef<number | undefined>(undefined);
  const teardown = useRef<(() => void) | undefined>(undefined);

  const onLeftEdge = column.pinned === "right";

  // if we unmount mid-drag, drop the window listeners (no state update here — the component is gone)
  useEffect(() => () => teardown.current?.(), []);

  const beginResize = (e: React.PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation(); // don't open the header menu
    drag.current = { startX: e.clientX, startWidth: column.width };
    setResizing(true);

    let latestX = e.clientX;
    const applyFrame = (): void => {
      raf.current = undefined;
      if (!drag.current) return;
      const delta = latestX - drag.current.startX;
      const next = drag.current.startWidth + (onLeftEdge ? -delta : delta);
      column.setManualWidth(Math.max(column.minWidth, next));
    };
    const onMove = (ev: PointerEvent): void => {
      latestX = ev.clientX;
      if (raf.current === undefined) raf.current = requestAnimationFrame(applyFrame);
    };
    const stop = (): void => {
      drag.current = null;
      setResizing(false);
      teardown.current?.();
    };

    teardown.current = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (raf.current !== undefined) {
        cancelAnimationFrame(raf.current);
        raf.current = undefined;
      }
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      teardown.current = undefined;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    // keep the resize cursor and suppress text selection for the whole drag, not just over the handle
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  const resetWidth = (e: React.MouseEvent): void => {
    e.stopPropagation();
    column.setManualWidth(undefined);
  };

  const style: CSSProperties = {
    position: "absolute",
    top: 0,
    ...(onLeftEdge ? { left: 0 } : { right: 0 }),
    width: "9px",
    height: "100%",
    cursor: "col-resize",
    touchAction: "none",
    userSelect: "none",
    zIndex: 1,
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="column-resizer"
      data-resizing={resizing || undefined}
      onPointerDown={beginResize}
      onDoubleClick={resetWidth}
      style={style}
    />
  );
});
