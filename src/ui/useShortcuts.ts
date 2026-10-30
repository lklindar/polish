import { useEffect } from 'react';
import { useStore } from '../state/store';
import { usePlayer } from './playerContext';

/** Space play/pause · J/K/L shuttle · ←/→ ±1 s · Del cut/toggle selection · ⌘Z / ⇧⌘Z undo/redo. */
export function useShortcuts() {
  const player = usePlayer();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"]')) return;
      const s = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          player.shuttle = 1;
          player.toggle();
          break;
        case 'k':
          player.shuttle = 1;
          player.pause();
          break;
        case 'l':
          // Each press while playing doubles the shuttle speed (up to 4×).
          player.shuttle = player.playing ? Math.min(4, player.shuttle * 2) : 1;
          void player.play();
          break;
        case 'j':
          // HTML video can't play backwards; J steps back 5 s.
          player.seek(Math.max(0, player.srcTime - 5));
          break;
        case 'ArrowLeft':
          player.seek(Math.max(0, player.srcTime - (e.shiftKey ? 5 : 1)));
          break;
        case 'ArrowRight':
          player.seek(player.srcTime + (e.shiftKey ? 5 : 1));
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          s.deleteSelection();
          break;
        case 'Escape':
          s.setSelection(null);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);
}
