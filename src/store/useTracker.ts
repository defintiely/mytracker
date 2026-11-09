import { useSyncExternalStore } from 'react';
import { store } from './store';
import type { TrackerDoc } from '../model/types';

/** React-хук: текущий документ трекера, перерисовка при каждом изменении. */
export function useTracker(): TrackerDoc {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getDoc(),
  );
}
