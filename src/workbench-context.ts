import { createContext, useContext } from 'react';
export type WorkbenchFile = { id: string; name: string; mime: string };
export const WorkbenchContext = createContext<((file: WorkbenchFile) => void) | null>(null);
export const useWorkbench = () => useContext(WorkbenchContext);
