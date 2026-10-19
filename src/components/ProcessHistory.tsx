import { useState, type ReactNode } from 'react';
export function ProcessHistory({ children, label }: { children: ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="completed-process"
      onToggle={(e) => {
        if (e.target === e.currentTarget) setOpen(e.currentTarget.open);
      }}
    >
      <summary>{label}</summary>
      {open ? children : null}
    </details>
  );
}
