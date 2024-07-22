import { useCallback, useRef } from "react";
import { IEntry } from "./App";
import { btoh, EntityDB } from '@interncom/diplomatic'

const debounceMillis = 500;

interface IProps {
  entity: EntityDB.IEntity<IEntry>;
  onChange: (eid: string, entry: IEntry) => void;
  onDelete: (eid: string) => void;
}
export default function Entry({ entity, onChange, onDelete }: IProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timeoutRef = useRef<number>();
  const hex = btoh(entity.eid);
  const entry = entity.body;
  const handleChange = useCallback(() => {
    clearTimeout(timeoutRef.current);
    const newEntry: IEntry = { ...entry, text: textareaRef.current?.value ?? '' };
    timeoutRef.current = setTimeout(() => onChange(hex, newEntry), debounceMillis)
  }, [entry, hex, onChange]);
  return (
    <div style={{ margin: '10px 0 4px 0' }}>
      <div style={{ fontSize: 10, display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ textAlign: 'left' }}>{entity.createdAt.toLocaleString()}</div>
        <a style={{ cursor: 'pointer' }} onClick={() => onDelete(hex)}>remove</a>
      </div>
      <textarea style={{ width: '100%', padding: 4, boxSizing: 'border-box' }} ref={textareaRef} onChange={handleChange} defaultValue={entry.text} />
    </div>
  );
}
