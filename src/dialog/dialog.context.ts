import { createContext, useContext } from "react";
import type { DialogModel } from "./dialog.model";
import type { DialogStore } from "./dialog.store";

export const dialogStoreContext = createContext<DialogStore | undefined>(undefined);
export const useDialogStore = () => {
  const context = useContext(dialogStoreContext);
  if (!context) {
    throw new Error("Dialog store context not available. Are you using the <Dialogs /> component?");
  }
  return context;
};

export const DialogStoreProvider = dialogStoreContext.Provider;

export const dialogContext = createContext<DialogModel | undefined>(undefined);
export const useDialogContext = () => {
  const context = useContext(dialogContext);
  if (!context) {
    throw new Error("Dialog context not available. Are you using <DialogProvider /> ?");
  }
  return context;
};

export const useDialogContextIfAvailable = () => useContext(dialogContext);

export const DialogProvider = dialogContext.Provider;
