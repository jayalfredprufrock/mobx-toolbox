import { observer } from "mobx-react-lite";
import { DialogProvider, DialogStoreProvider } from "../dialog.context";
import type { DialogModel } from "../dialog.model";
import type { DialogStore } from "../dialog.store";
import { useDialogs } from "../use-dialogs";

export interface MobxDialogsProps {
  store?: DialogStore;
}

export const MobxDialogs = observer(({ store }: MobxDialogsProps) => {
  const dialogStore = useDialogs(store);

  return (
    <DialogStoreProvider value={dialogStore}>
      {dialogStore.openDialogs.map((dialog) => {
        return <MobxDialog key={dialog.id} dialog={dialog} />;
      })}
    </DialogStoreProvider>
  );
});

export interface MobxDialogProps {
  dialog: DialogModel;
}

export const MobxDialog = observer(({ dialog }: MobxDialogProps) => {
  const { component: DialogComponent, props: dialogProps } = dialog;
  return (
    <DialogProvider value={dialog}>
      <DialogComponent {...dialogProps} />
    </DialogProvider>
  );
});
