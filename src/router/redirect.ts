import type { NavigateOptions, RoutePath } from "./types";

export class Redirect<P extends RoutePath> {
  constructor(readonly options: NavigateOptions<P>) {}
}

export const redirect = <P extends RoutePath>(options: NavigateOptions<P>): Redirect<P> =>
  new Redirect(options);
