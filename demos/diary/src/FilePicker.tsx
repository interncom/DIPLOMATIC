interface IProps {
  onPick: (buf: File) => void;
}
export default function FilePicker({ onPick }: IProps) {
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      onPick(file);
    }
  };
  return <input type="file" onChange={handleFileSelect} />
}
