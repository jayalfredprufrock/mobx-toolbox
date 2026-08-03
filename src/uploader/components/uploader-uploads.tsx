import { observer } from "mobx-react-lite";
import { type FC, Fragment, type ReactNode } from "react";
import { useUploaderContext } from "../uploader.context";
import type { Upload } from "../uploader.types";

export interface UploaderUploadsProps {
  /** Renders one upload — in-flight and already-completed alike. */
  children: (upload: Upload) => ReactNode;
}

/**
 * Renders every upload through your render prop, in display order, keyed on `upload.key`.
 *
 * Emits no DOM element of its own, so it drops straight into whatever list markup you already have.
 * Reading `uploader.uploads` yourself inside an `observer` is equivalent — this only saves reaching
 * for the context and remembering which identity is the stable one.
 */
export const UploaderUploads: FC<UploaderUploadsProps> = observer(({ children }) => {
  const { uploader } = useUploaderContext();

  return (
    <>
      {uploader.uploads.map((upload) => (
        <Fragment key={upload.key}>{children(upload)}</Fragment>
      ))}
    </>
  );
});
