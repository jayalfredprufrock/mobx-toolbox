import { useEffect, useRef } from "react";
import { UploaderModel } from "./uploader.model";
import type { UploaderConfig } from "./uploader.types";

export const useUploader = (config: UploaderConfig): UploaderModel => {
  const uploaderRef = useRef<UploaderModel | undefined>(undefined);

  if (uploaderRef.current) {
    // Refresh the config in place (as useForm does) so inline `onChange` / `requestUpload` lambdas
    // are always the current ones. The model reads them off `config` at fire time, so its reaction
    // never re-subscribes and an inline arrow costs nothing.
    Object.assign(uploaderRef.current.config, config);
  } else {
    uploaderRef.current = new UploaderModel(config);
  }

  // The model's onChange reaction must die with the component or it leaks past unmount.
  // activate/dispose as an effect pair (not dispose alone) because StrictMode's dev remount runs
  // cleanup against a model the surviving ref will hand out again — and here dispose only *parks*
  // the uploads, so activate picks them back up instead of restarting them.
  useEffect(() => {
    uploaderRef.current?.activate();
    return () => uploaderRef.current?.dispose();
  }, []);

  // Controlled sync, inbound half. Deliberately runs after every commit with no dep array: `value`
  // is normally a fresh array literal, so an identity dep would never skip anything anyway, and
  // `applyValue` is a guarded no-op once the id set already matches. Presence of the `value` key —
  // not its nullishness — decides controlled-ness, so `undefined` still means "no uploads" while an
  // onChange-only uploader keeps owning its own list.
  useEffect(() => {
    if ("value" in config) {
      uploaderRef.current?.applyValue(config.value ?? []);
    }
  });

  return uploaderRef.current;
};
