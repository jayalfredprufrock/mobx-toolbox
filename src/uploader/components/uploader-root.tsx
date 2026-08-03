import {
  type ChangeEvent,
  type FC,
  type InputHTMLAttributes,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { UploaderProvider } from "../uploader.context";
import type { UploaderModel } from "../uploader.model";

export interface UploaderRootProps {
  uploader: UploaderModel;
  /**
   * Escape hatch for the hidden file input (`id`, `name`, `form`, …). Spread *before* the library's
   * own attributes. `accept`, `multiple` and `capture` come from `uploader.config` so there is one
   * place to set them, and `type`/`onChange` are the component's own.
   */
  inputProps?: Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "value" | "onChange" | "accept" | "multiple" | "capture"
  >;
  children?: ReactNode;
}

/**
 * Owns the hidden `<input type="file">` — and therefore the only way to open the file dialog, which
 * it publishes on the context as `openFileDialog` — and provides the model to everything below.
 *
 * Renders **no wrapper element**: an uploader has no structural DOM requirement the way a virtualized
 * table's scroll viewport does, so a div here would only be a box you have to style around. Wrap the
 * children in your own container.
 */
export const UploaderRoot: FC<UploaderRootProps> = ({ uploader, inputProps, children }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // A stable callback over a ref, not state set from a ref callback: children render on the first
  // pass and a remount costs no extra render.
  const openFileDialog = useCallback(() => inputRef.current?.click(), []);
  const context = useMemo(() => ({ uploader, openFileDialog }), [uploader, openFileDialog]);

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const { files } = e.target;
      if (files?.length) uploader.addFiles(files);
      // clear the input so picking the same file again still fires a change event
      e.target.value = "";
    },
    [uploader],
  );

  return (
    <UploaderProvider value={context}>
      <input
        {...inputProps}
        ref={inputRef}
        type="file"
        accept={uploader.config.accept}
        multiple={uploader.config.multiple}
        capture={uploader.config.capture}
        onChange={onInputChange}
        // a nameless file input in the tab order is worse than no input at all; the control that
        // opens the dialog is yours, and it is a real button
        tabIndex={-1}
        aria-hidden="true"
        style={{ display: "none" }}
      />
      {children}
    </UploaderProvider>
  );
};
