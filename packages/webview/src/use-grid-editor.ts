import { useEffect, useRef, useState } from 'react';
import { errorMessage, type DataRow, type GridEditState, type GridEditorState, type RowChange } from '../../protocol/src/index.js';
import { onEditorFlush, onEditorState, rpc } from './bridge.js';

export const ROW_ID: unique symbol = Symbol('row-id');
export interface GridRow extends DataRow { [ROW_ID]: string; }
export interface EditSnapshot { edits: Record<string, RowChange>; added: GridRow[]; }
export function fromWireEdits(state: GridEditState): EditSnapshot { return { edits: state.edits, added: state.added.map(row => ({ ...row.values, [ROW_ID]: row.id })) }; }
function toWireEdits(state: EditSnapshot, keyColumns: string[]): GridEditState { return { edits: state.edits, added: state.added.map(row => ({ id: row[ROW_ID], values: Object.fromEntries(Object.entries(row)) })), keyColumns }; }

export function useGridEditor(initial: GridEditorState | undefined, handlers: { apply(state: GridEditorState): void; stopEditing(): void; error(message: string): void }) {
  const [state, setState] = useState(initial);
  const revision = useRef(initial?.revision ?? 0), queue = useRef<Promise<void>>(Promise.resolve()), failure = useRef<string | undefined>(undefined);
  const callbacks = useRef(handlers); callbacks.current = handlers;
  const accept = (next: GridEditorState) => { if (next.revision < revision.current) return; revision.current = next.revision; failure.current = undefined; setState(next); callbacks.current.apply(next); };
  const synchronize = async () => {
    callbacks.current.stopEditing();
    // AG Grid dispatches edit-request listeners in its next timer task. Let that
    // task enqueue the final input before taking the synchronization queue.
    await new Promise<void>(resolve=>setTimeout(resolve,0));
    await queue.current;
    if (failure.current) throw new Error(failure.current);
  };
  useEffect(() => onEditorState(accept), []);
  useEffect(() => onEditorFlush(token => { void (async () => {
    let error: string | undefined;
    try { await synchronize(); } catch (reason) { error = errorMessage(reason); }
    await rpc({ method: 'editor.flush-complete', params: { token, error } });
  })().catch(reason => callbacks.current.error(errorMessage(reason))); }), []);
  const enqueue = (operation: () => Promise<void>) => {
    queue.current = queue.current.then(async () => { if (failure.current) throw new Error(failure.current); await operation(); }).catch(reason => { failure.current = errorMessage(reason); callbacks.current.error(failure.current); });
  };
  return {
    enabled: Boolean(initial), state, synchronize,
    update(snapshot: EditSnapshot, keys: string[]) {
      if (!initial) return;
      const edits = toWireEdits(snapshot, keys);
      enqueue(async () => { const next = await rpc<GridEditorState>({ method: 'editor.update', params: { revision: revision.current, state: edits } }); if (next.revision >= revision.current) { revision.current = next.revision; setState(next); } });
    },
    keys(keys: string[]) { if (initial) enqueue(async () => { await rpc({ method: 'editor.keys', params: { keyColumns: keys } }); }); },
    async action(action: 'save' | 'undo' | 'redo') {
      await synchronize();
      const next = await rpc<GridEditorState>({ method: action === 'save' ? 'editor.save' : action === 'undo' ? 'editor.undo' : 'editor.redo', params: {} });
      accept(next);
    },
  };
}
