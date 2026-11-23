// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef } from 'react';

/**
 * Runs something once no pointer is pressed any more.
 *
 * A field that loses the focus may show a message under it, and that moves
 * everything below. When the focus is lost because the author pressed a
 * button, the button would move away between press and release, and the click
 * would go nowhere. So what a blur shows waits until the pointer is released
 * and its click was delivered. Without a pressed pointer (the Tab key) it
 * runs at once.
 *
 * @returns {(run: () => void) => void}
 */
export function usePointerSettled() {
  const pressedRef = useRef(false);
  const waitingRef = useRef([]);

  useEffect(() => {
    let timer = null;
    const onDown = () => {
      pressedRef.current = true;
    };
    const onUp = () => {
      pressedRef.current = false;
      if (waitingRef.current.length === 0 || timer !== null) return;
      // After the click that follows the release.
      timer = setTimeout(() => {
        timer = null;
        const waiting = waitingRef.current;
        waitingRef.current = [];
        waiting.forEach(run => run());
      }, 0);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('pointercancel', onUp, true);
    };
  }, []);

  return useCallback(run => {
    if (pressedRef.current) waitingRef.current.push(run);
    else run();
  }, []);
}

export default usePointerSettled;
