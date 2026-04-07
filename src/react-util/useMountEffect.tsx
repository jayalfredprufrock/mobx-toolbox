import { useEffect } from "react";

export const useMountEffect = (effectFn: React.EffectCallback): void => useEffect(effectFn, []);
