import { useLayoutEffect } from "react";
import type { NavigateOptions, RoutePath } from "../types";
import { useRouter } from "./router";

export const Navigate = <P extends RoutePath>(props: NavigateOptions<P>) => {
  const router = useRouter();

  useLayoutEffect(() => {
    router.navigate(props);
  }, [router, props]);

  return null;
};
