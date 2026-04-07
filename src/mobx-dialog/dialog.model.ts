import { makeAutoObservable } from "mobx";
import type { DialogStore } from "./dialog.store";
import type { AnyComponent, DialogModelConfig, DialogState } from "./dialog.types";

export class DialogModel {
  readonly id: string;
  readonly component: AnyComponent;
  readonly props?: React.ComponentProps<AnyComponent>;

  openedAt = 0;
  previouslyFocusedElement: HTMLElement | null = null;

  state!: DialogState;

  constructor(
    readonly store: DialogStore,
    readonly config: DialogModelConfig,
  ) {
    this.id = config.id ?? btoa(Math.random().toString()).substring(3, 12);
    this.component = config.component;
    this.props = config.props;

    this.setState(config.initialState ?? "closed");

    makeAutoObservable(this, {
      id: false,
      component: false,
      props: false,
      openedAt: false,
      previouslyFocusedElement: false,
    });
  }

  close(closeImmediately?: boolean): void {
    this.setState(closeImmediately ? "closed" : "closing");
  }

  open(openImmediately?: boolean): void {
    this.setState(openImmediately ? "opened" : "opening");
  }

  setState(state: DialogState): void {
    if (this.state === state) return;

    this.state = state;
    if (state === "opened" || state === "opening") {
      this.openedAt = Date.now();
      if (state === "opening") {
        this.previouslyFocusedElement =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
    } else if (state === "closed") {
      this.previouslyFocusedElement?.focus();
      if (this.config.removeOnClosed) {
        this.store.dialogs.delete(this.id);
      }
      this.previouslyFocusedElement = null;
    }
  }
}
