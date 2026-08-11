import { observer } from "mobx-react-lite";
import React, { useCallback } from "react";
import type {
  DynamicRoutePath,
  ExtractParams,
  NavigateOptions,
  RoutePath,
  StaticRoutePath,
} from "../types";
import { resolvePath } from "../util";
import { useRouter } from "./router";

type LinkComponentProps<C extends React.ElementType> = Omit<
  React.ComponentProps<C>,
  "ref" | "exact" | "to" | "params" | "onClick" | "asChild"
>;

export type LinkPropsBase<
  C extends React.ElementType,
  I extends React.ElementType = C,
> = LinkComponentProps<C> & {
  exact?: boolean;
  preserveSearch?: boolean;
  ref?: React.Ref<React.ComponentRef<I>>;
  /**
   * Runs before the link navigates, and can cancel it with
   * `preventDefault()`. Declared here rather than inherited from `C` so the
   * signature stays the same whatever element the link renders as.
   */
  onClick?: (event: React.MouseEvent<HTMLElement>) => void;
};

// function overloading is much faster than leveraging conditional types
// but once the typescript go compiler is released and performance is no
// longer an issue, it might make sense to simplify this a bit so it can
// be more easily consumed by users
export interface LinkComponent<C extends React.ElementType, I extends React.ElementType = C> {
  <P extends StaticRoutePath>(
    props: LinkPropsBase<C, I> & { to: P; params?: undefined },
  ): React.ReactNode;
  <P extends DynamicRoutePath>(
    props: LinkPropsBase<C, I> & { to: P; params: ExtractParams<P> },
  ): React.ReactNode;
}

// final thing to do is make sure refs still work in React 19

// this smooths over some of the awkwardness when extending this component
export const makeLinkComponent = <C extends React.ElementType, I extends React.ElementType = C>(
  C: C,
  baseProps?: Partial<LinkComponentProps<C>> & {
    as?: I;
    onClick?: (event: React.MouseEvent<HTMLElement>) => void;
  },
) => {
  return observer(({ to, params, exact, preserveSearch, children, ...props }: any) => {
    const router = useRouter();
    const mergedProps = { ...baseProps, ...props };

    if (props.role !== "link") {
      mergedProps.href = resolvePath(to, params);
    }

    if (router.doesPathMatch(to, exact)) {
      mergedProps["aria-current"] = "page";
    }

    const onClick = props.onClick ?? baseProps?.onClick;
    const hasHref = mergedProps.href !== undefined;

    mergedProps.onClick = useCallback(
      (event: React.MouseEvent<HTMLElement>) => {
        // a disabled link is inert: no navigation, no href, and no handler
        // — the same as a native disabled control
        if (props.disabled) {
          event.preventDefault();
          return;
        }

        // the caller's handler runs first and owns the decision: calling
        // preventDefault() cancels the navigation, and the href with it,
        // which is what a "confirm before leaving" handler wants
        onClick?.(event);
        if (event.defaultPrevented) return;

        // Let the browser have the ones it does better: cmd/ctrl-click opens
        // a new tab, shift a new window, alt downloads, middle-click a
        // background tab. The href is already correct, so the only thing
        // that broke these was cancelling the event. Only worth deferring to
        // when there is an href to follow — a link rendered as a button (or
        // with role="link") has none, so a modifier-click there navigates in
        // place rather than doing nothing at all.
        if (hasHref && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
          return;
        }

        // `button` is 0 for a primary click and for a keyboard-activated
        // one; a middle-click arrives as button 1 where it reaches click at
        // all (most browsers route it to auxclick, which is left untouched)
        if (hasHref && event.button !== 0) {
          return;
        }

        event.preventDefault();
        router.navigate({ to, preserveSearch, params } as NavigateOptions<RoutePath>);
      },
      [router, to, params, preserveSearch, props.disabled, onClick, hasHref],
    );

    return React.createElement(C, mergedProps, children);
  }) as LinkComponent<C, I>;
};

//export const Link = makeLinkComponent('a');
