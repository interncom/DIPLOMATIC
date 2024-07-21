import { useCallback, useRef } from "react";
import { IEntry } from "./App";

const debounceMillis = 500;

interface IProps {
  eid: string;
  entry: IEntry;
  onChange: (eid: string, entry: IEntry) => void;
  onDelete: (eid: string) => void;
}
export default function Entry({ eid, entry, onChange, onDelete }: IProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timeoutRef = useRef<number>();
  const handleChange = useCallback(() => {
    clearTimeout(timeoutRef.current);
    const newEntry: IEntry = { ...entry, text: textareaRef.current?.value ?? '' };
    timeoutRef.current = setTimeout(() => onChange(eid, newEntry), debounceMillis)
  }, [eid, entry, onChange]);
  return (
    <div key={eid} style={{ margin: '10px 0 4px 0' }}>
      <div style={{ fontSize: 10, display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ textAlign: 'left' }}>{entry.createdAt.toLocaleString()}</div>
        <a style={{ cursor: 'pointer' }} onClick={() => onDelete(eid)}>remove</a>
      </div>
      <textarea style={{ width: '100%', padding: 4, boxSizing: 'border-box' }} ref={textareaRef} onChange={handleChange} defaultValue={entry.text} />
    </div>
  );
}
