"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastKind = "success" | "error";

export type ToastState = {
  type: ToastKind;
  text: string;
} | null;

export function useAutoDismissToast(autoHideMs = 1200) {
  const [toast, setToast] = useState<ToastState>(null);
  const timerRef = useRef<number | null>(null);

  const clearToast = useCallback(() => {
    setToast(null);
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const showToast = useCallback(
    (type: ToastKind, text: string) => {
      setToast({ type, text });
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
      timerRef.current = window.setTimeout(() => setToast(null), autoHideMs);
    },
    [autoHideMs]
  );

  useEffect(() => clearToast, [clearToast]);

  return { toast, showToast, clearToast };
}

