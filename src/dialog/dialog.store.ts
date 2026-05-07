import { makeAutoObservable } from "mobx";
import { DialogModel } from "./dialog.model";
import type { AnyComponent, DialogComponentAndProps, DialogModelConfig } from "./dialog.types";

export class DialogStore {
  dialogs = new Map<string, DialogModel>();

  get openDialogs(): DialogModel[] {
    return [...this.dialogs.values()]
      .filter((d) => d.state !== "closed")
      .sort((d1, d2) => d1.openedAt - d2.openedAt);
  }

  get activeDialog(): DialogModel | undefined {
    return this.openDialogs.at(-1);
  }

  constructor() {
    makeAutoObservable(this);
  }

  add(config: DialogModelConfig): DialogModel {
    const dialogModel = new DialogModel(this, config);
    this.dialogs.set(dialogModel.id, dialogModel);
    return dialogModel;
  }

  open<C extends AnyComponent>(...args: DialogComponentAndProps<C>): DialogModel {
    const [component, props] = args;
    return this.add({
      component,
      props,
      removeOnClosed: true,
      initialState: "opening",
    });
  }

  close(closeImmediately?: boolean): void {
    this.activeDialog?.close(closeImmediately);
  }
}
