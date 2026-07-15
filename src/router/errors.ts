import type { MatchState } from "./make-routes";

export type RouterErrorType = "NOT_FOUND" | "GUARD" | "LOAD" | "RENDER";

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
