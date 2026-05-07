import { autorun, type IAutorunOptions, type IReactionPublic } from "mobx";
import { useEffect } from "react";

export function useAutorun(func: (r: IReactionPublic) => unknown, options?: IAutorunOptions): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: by design
  useEffect(() => autorun(func, options), []);
}
