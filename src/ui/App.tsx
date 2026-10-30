import { useEffect } from 'react';
import { useStore } from '../state/store';
import { Editor } from './Editor';
import { StartScreen } from './StartScreen';

export function App() {
  const phase = useStore((s) => s.phase);
  const init = useStore((s) => s.init);
  useEffect(() => {
    void init();
    // Dev only: `?src=/.dev-media/sample.mp4` preloads a file without the picker (for automated checks).
    const src = import.meta.env.DEV ? new URLSearchParams(location.search).get('src') : null;
    if (src) {
      void fetch(src)
        .then((r) => r.blob())
        .then((b) => useStore.getState().setFile(new File([b], decodeURIComponent(src.split('/').pop()!), { type: 'video/mp4' })));
    }
  }, [init]);
  return phase === 'editor' ? <Editor /> : <StartScreen />;
}
