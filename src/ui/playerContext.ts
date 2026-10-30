import { createContext, useContext, useSyncExternalStore } from 'react';
import type { EdlPlayer } from '../player/EdlPlayer';

export const PlayerContext = createContext<EdlPlayer | null>(null);

export function usePlayer(): EdlPlayer {
  const p = useContext(PlayerContext);
  if (!p) throw new Error('PlayerContext missing');
  return p;
}

/** Re-renders on play/pause/segment changes (not every frame). */
export function usePlaying(player: EdlPlayer): boolean {
  return useSyncExternalStore(
    (fn) => player.subscribe(fn),
    () => player.playing,
  );
}
