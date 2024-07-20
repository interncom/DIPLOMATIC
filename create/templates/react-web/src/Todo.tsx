import { ITodo } from "./App";

interface IProps {
  eid: string;
  todo: ITodo;
  onChange: (eid: string, text: string, checked: boolean) => void;
  onDelete: (eid: string) => void;
}
export default function Todo({ eid, todo, onChange, onDelete }: IProps) {
  return (
    <div key={eid} style={{ display: 'flex', alignItems: 'center', margin: '4px 0' }}>
      <input
        type="checkbox"
        checked={todo.done ?? false}
        onChange={e => onChange(eid, todo.text, e.target.checked)}
        style={{ marginLeft: 0 }}
      />
      <div style={{ flex: 1, textAlign: 'left' }}>{todo.text}</div>
      <a style={{ cursor: 'pointer' }} onClick={() => onDelete(eid)}>x</a>
    </div>
  );
}
