import { observer } from "mobx-react-lite";
import React, { type HTMLProps, useCallback } from "react";
import type {
  DynamicRoutePath,
  ExtractParams,
  NavigateOptions,
  RoutePath,
  StaticRoutePath,
} from "../types";
import { resolvePath } from "../util";
import { useRouter } from "./router";

// function overloading is much faster than leveraging conditional types
// but is a bit awkward to use without the makeLinkComponent helper below.
// consider the commented out solution once the typescript go compiler
// is released if performance is no longer an issue
export interface LinkComponent<T> {
  <P extends StaticRoutePath>(props: T & { to: P; params?: undefined }): React.ReactNode;
  <P extends DynamicRoutePath>(props: T & { to: P; params: ExtractParams<P> }): React.ReactNode;
}

export interface LinkPropsBase extends Omit<HTMLProps<HTMLAnchorElement>, "onClick" | "href"> {
  exact?: boolean;
  ref?: React.RefObject<HTMLAnchorElement>;
}

export type Link = LinkComponent<LinkPropsBase>;
export type LinkProps = React.ComponentProps<Link>;

export const Link = observer((({ to, params, exact, children, ...props }: LinkProps) => {
  const router = useRouter();

  const resolvedPath = resolvePath(to, params);

  const matchingProps = router.doesPathMatch(to, exact)
    ? ({ "aria-current": "page" } as const)
    : undefined;

  const onClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
      event.preventDefault();
      router.navigate({ to, ...(params as any) } as NavigateOptions<RoutePath>);
    },
    [router, params, to],
  );

  return (
    <a href={resolvedPath} {...props} {...matchingProps} onClick={onClick}>
      {children}
    </a>
  );
}) as Link);

// this smooths over some of the awkwardness when extending this component
export const makeLinkComponent = <
  C extends React.JSXElementConstructor<{ children?: React.ReactNode }>,
>(
  C: C,
) => {
  return (({ children, to, params, ...props }: any) => (
    <C {...props}>
      <Link to={to as any} params={params as any}>
        {children}
      </Link>
    </C>
  )) as LinkComponent<React.ComponentProps<C>>;
};

/*
export interface LinkPropsBase extends Omit<HTMLProps<HTMLAnchorElement>, 'onClick' | 'href'> {
	ref?: React.RefObject<HTMLAnchorElement>;
}

export type LinkProps<P extends RoutePath> = WithToAndParams<P, LinkPropsBase>;

export const Link = <P extends RoutePath>({ to, params, children, ...props }: LinkProps<P>) => {
	const router = useRouter();

	const resolvedPath = resolvePath(to, params);

	const onClick = useCallback(
		(event: React.MouseEvent<HTMLAnchorElement, MouseEvent>) => {
			event.preventDefault();
			router.navigate({ to, ...params } as NavigateOptions<RoutePath>);
		},
		[router, params, to],
	);

	return (
		<a href={resolvedPath} {...props} onClick={onClick} ref={ref}>
			{children}
		</a>
	);
};
*/
