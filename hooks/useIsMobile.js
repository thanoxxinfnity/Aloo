import { useEffect, useState } from 'react';

/**
 * Viewport-width breakpoint as React state.
 *
 * Starts `false` and resolves after mount — deliberately. There is no viewport
 * on the Node server, so reading `window.innerWidth` during render would make
 * the server and client markup disagree and fail hydration. The one frame of
 * desktop layout before the effect runs is invisible next to the WebGL canvas
 * mounting anyway.
 */
export default function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const apply = () => setIsMobile(mq.matches);
    apply();
    // Safari < 14 only has addListener.
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else mq.addListener(apply);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', apply);
      else mq.removeListener(apply);
    };
  }, [breakpoint]);

  return isMobile;
}
