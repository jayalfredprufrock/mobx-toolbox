import type { FC } from "react";

export type DialogState = "opening" | "opened" | "closing" | "closed";

type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];

export type AnyComponent = FC<any>;

export type DialogComponentAndProps<C extends AnyComponent, P = Parameters<C>[0]> =
  RequiredKeys<P> extends never ? [C, P?] : [C, P];

export interface DialogModelConfig {
  id?: string;
  component: AnyComponent;
  props?: React.ComponentProps<AnyComponent>;
  removeOnClosed?: boolean;
  initialState?: DialogState;
}
