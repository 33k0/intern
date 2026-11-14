// Tiny external store around the pure reducer, plus the React hook that reads slices of it.

import { useSyncExternalStore } from 'react';
import { initialState, reduce, type Action, type PanelState } from './state';

type Listener = () => void;

export interface Store {
  getState(): PanelState;
  dispatch(action: Action): void;
  subscribe(listener: Listener): () => void;
}

export function createStore(): Store {
  let state = initialState();
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export const store = createStore();

/**
 * Subscribe to one slice. The selector must return a primitive or a reference taken straight
 * from the state (which is immutable), so unchanged slices do not re-render their component.
 */
export function useSel<T>(selector: (s: PanelState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
