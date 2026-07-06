import { useState, useEffect } from "react";

export interface DeviceInfo {
  isMobile: boolean;   // < 640px
  isTablet: boolean;   // 640–1023px
  isDesktop: boolean;  // ≥ 1024px
  isNarrow: boolean;   // < 768px (legacy compat — prefer isMobile/isTablet)
  isLandscape: boolean;
  isTouch: boolean;
  width: number;
  height: number;
}

function getDevice(): DeviceInfo {
  const w = typeof window !== "undefined" ? window.innerWidth : 1024;
  const h = typeof window !== "undefined" ? window.innerHeight : 768;
  return {
    isMobile: w < 640,
    isTablet: w >= 640 && w < 1024,
    isDesktop: w >= 1024,
    isNarrow: w < 768,
    isLandscape: w > h,
    isTouch: typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0),
    width: w,
    height: h,
  };
}

export function useDevice(): DeviceInfo {
  const [device, setDevice] = useState(getDevice);

  useEffect(() => {
    const handler = () => setDevice(getDevice());
    window.addEventListener("resize", handler);
    window.addEventListener("orientationchange", handler);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") handler();
    });
    window.addEventListener("focus", handler);
    window.visualViewport?.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("resize", handler);
      window.removeEventListener("orientationchange", handler);
      window.removeEventListener("focus", handler);
      window.visualViewport?.removeEventListener("resize", handler);
    };
  }, []);

  return device;
}
