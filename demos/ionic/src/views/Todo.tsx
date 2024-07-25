import { IonCheckbox, IonInput, IonItem, IonItemOption, IonItemOptions, IonItemSliding, useIonToast } from "@ionic/react";
import { ITodo, opType } from "./Home";
import "./todo.css";
import { useState, useCallback } from "react";
import { client } from "../client";
import { htob } from "@interncom/diplomatic";

interface IProps {
  eid: string;
  todo: ITodo;
  onChange: (eid: string, text: string, checked: boolean) => void;
  onDelete: (eid: string) => void;
}
export default function Todo({ eid, todo, onChange, onDelete }: IProps) {
  const [valueField, setValueField] = useState(todo.text);
  const [present] = useIonToast();
  const handleSubmit = useCallback(async (evt: React.FormEvent) => {
    evt.preventDefault();
    if (valueField.length < 1) {
      onDelete(eid);
      return;
    }
    const todo: ITodo = { text: valueField };
    const eidBytes = htob(eid);
    client.upsert<ITodo>(opType, todo, eidBytes);
    present({ message: "Saved", duration: 250, color: "success" });
  }, [valueField, eid, present, onDelete]);

  return (
    <IonItemSliding>
      <form onSubmit={handleSubmit}>
        <IonItem lines="full">
          <IonCheckbox slot="start" aria-label="Toggle completion" checked={todo.done ?? false} onIonChange={e => onChange(eid, todo.text, e.target.checked)} />
          <IonInput aria-label="Todo name" value={valueField} onIonInput={(evt) => setValueField(evt.target.value as string)} />
        </IonItem>
      </form>
      <IonItemOptions onIonSwipe={() => onDelete(eid)}>
        <IonItemOption color="danger" expandable onClick={() => onDelete(eid)}>Delete</IonItemOption>
      </IonItemOptions>
    </IonItemSliding>
  );
}
