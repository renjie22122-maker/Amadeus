import { ChevronRight } from 'lucide-react';
export function ProcessHistory({
  label,
  open,
  onChange,
  controls,
}: {
  label: string;
  open: boolean;
  onChange: (open: boolean) => void;
  controls: string;
}) {
  return (
    <div className="completed-process">
      <button
        className="process-toggle"
        aria-expanded={open}
        aria-controls={controls}
        onClick={() => onChange(!open)}
      >
        <ChevronRight size={14} style={{ transform: open ? 'rotate(90deg)' : undefined }} />
        {label}
      </button>
    </div>
  );
}
