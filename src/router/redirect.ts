import type { MatchState } from "./make-routes";
import type { NavigateOptions, RoutePath } from "./types";

export class Redirect<P extends RoutePath = RoutePath> {
  /**
   * @internal matched-prefix state, set when the matcher throws this for a
   * `[REDIRECT]` leaf. Used to render the error route if the redirect fails.
   */
  state?: MatchState;
  /** @internal level index of the guard that threw, for depth-aware bubbling */
  depth?: number;

  constructor(readonly options: NavigateOptions<P>) {}
}

export const redirect = <P extends RoutePath>(options: NavigateOptions<P>): Redirect<P> =>
  new Redirect(options);
