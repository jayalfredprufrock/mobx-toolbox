import { useRef } from "react";
import { DialogStore } from "./dialog.store";

export const useDialogs = (store?: DialogStore): DialogStore => {
  const storeRef = useRef<DialogStore | undefined>(store);
  if (!storeRef.current) {
    storeRef.current = new DialogStore();
  }
  return storeRef.current;
};
