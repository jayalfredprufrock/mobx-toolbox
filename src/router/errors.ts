import type { MatchState } from "./make-routes";

export type RouterErrorType = "NOT_FOUND" | "GUARD" | "LOAD" | "RENDER" | "REDIRECT";

export interface RouterErrorOptions {
  message?: string;
  cause?: unknown;
  path?: string;
}

const defaultMessage = (type: RouterErrorType, path?: string): string => {
  switch (type) {
    case "NOT_FOUND":
      return path ? `No route matches '${path}'.` : "No matching route.";
    case "GUARD":
      return "A route guard rejected the navigation.";
    case "LOAD":
      return "A route loader or lazy component failed.";
    case "RENDER":
      return "A route component failed to render.";
    case "REDIRECT":
      return path
        ? `The redirect for '${path}' could not be resolved.`
        : "A redirect could not be resolved.";
  }
};

/**
 * The single error type surfaced to `[ERROR]` components. `type`
 * discriminates the failure source; when the router wraps an
 * application-level error (thrown by a guard or loader), the original
 * is preserved on the standard `cause` property.
 *
 * Guards and loaders may also throw `RouterError` directly — e.g.
 * `throw new RouterError("NOT_FOUND")` from a loader when an entity
 * doesn't exist — and it passes through unwrapped.
 */
export class RouterError extends Error {
  readonly type: RouterErrorType;
  readonly path?: string;

  /** @internal matched-prefix state captured when the matcher throws NOT_FOUND */
  state?: MatchState;
  /** @internal level index of the failing guard, for depth-aware bubbling */
  depth?: number;

  constructor(type: RouterErrorType, options?: RouterErrorOptions) {
    super(options?.message ?? defaultMessage(type, options?.path), { cause: options?.cause });
    this.name = "RouterError";
    this.type = type;
    this.path = options?.path;
  }
}

/**
 * @internal Builds the `REDIRECT` error for a redirect that could not be
 * carried out — a `[REDIRECT]` function that threw, or navigation options
 * naming a path whose `:params` can't be filled.
 *
 * `from` carries whatever the `Redirect` knew about where it came from, so
 * the error route keeps the matched prefix's layout and wrappers and bubbles
 * to the same `[ERROR]` a failure at that level would have.
 */
export const redirectFailed = (
  cause: unknown,
  path: string | undefined,
  from?: { state?: MatchState; depth?: number },
): RouterError => {
  const error = new RouterError("REDIRECT", { cause, path });
  error.state = from?.state;
  error.depth = from?.depth;
  return error;
};
