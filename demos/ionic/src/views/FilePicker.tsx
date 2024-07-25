import { IonItem } from '@ionic/react';
import { useRef } from 'react';

interface IProps {
  onPick: (buf: File) => void;
}
export default function FilePicker({ onPick }: IProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      onPick(file);
    }
  };

  const handleItemClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleFileSelect}
      />
      <IonItem button onClick={handleItemClick} detail={false}>
        Import
      </IonItem>
    </>
  );
}
