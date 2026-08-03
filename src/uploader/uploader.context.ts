import { createContext, useContext } from "react";
import type { UploaderModel } from "./uploader.model";

/**
 * What the parts below `<Uploader.Root>` need: the model, plus the one thing only the root can
 * provide — a handle on its hidden `<input type="file">`. Opening the file dialog is a DOM
 * capability, not model state, so it rides the context rather than the model.
 */
export interface UploaderContextValue {
  uploader: UploaderModel;
  /** Opens the root's hidden file input. Must be called from within a user gesture. */
  openFileDialog: () => void;
}

export const uploaderContext = createContext<UploaderContextValue | undefined>(undefined);

export const useUploaderContext = (): UploaderContextValue => {
  const context = useContext(uploaderContext);
  if (!context) {
    throw new Error(
      "Uploader context not available. Are you within the <Uploader.Root /> component?",
    );
  }
  return context;
};

export const UploaderProvider = uploaderContext.Provider;
