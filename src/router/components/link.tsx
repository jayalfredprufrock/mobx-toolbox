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
  " ref" | "exact" | "to" | "params" | "onClick"
>;

export type LinkPropsBase<
  C extends React.ElementType,
  I extends React.ElementType = C,
> = LinkComponentProps<C> & {
  exact?: boolean;
  preserveSearch?: boolean;
  ref?: React.Ref<React.ComponentRef<I>>;
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
  baseProps?: Partial<LinkComponentProps<C>> & { as?: I },
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

    mergedProps.onClick = useCallback(
      (event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        if (props.disabled) return;
        router.navigate({ to, preserveSearch, ...(params as any) } as NavigateOptions<RoutePath>);
      },
      [router, params, to, props.disabled],
    );

    return React.createElement(C, mergedProps, children);
  }) as LinkComponent<C, I>;
};

//export const Link = makeLinkComponent('a');
