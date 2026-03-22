import { useCallback, useEffect, useState } from "react";

export function useServiceWorker() {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    let registration: ServiceWorkerRegistration | null = null;

    const onStateChange = (sw: ServiceWorker) => {
      if (sw.state === "installed" && navigator.serviceWorker.controller) {
        // New SW installed while an old one is active — update available
        setWaitingWorker(sw);
        setUpdateAvailable(true);
      }
    };

    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        registration = reg;

        // If there's already a waiting worker (e.g. user returned to tab)
        if (reg.waiting) {
          setWaitingWorker(reg.waiting);
          setUpdateAvailable(true);
          return;
        }

        // Watch for a new installing worker
        if (reg.installing) {
          reg.installing.addEventListener("statechange", () =>
            onStateChange(reg.installing!)
          );
        }

        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener("statechange", () =>
              onStateChange(newWorker)
            );
          }
        });
      })
      .catch((err) => console.warn("SW registration failed:", err));

    // Also detect controller change (after skipWaiting) to reload
    let refreshing = false;
    const onControllerChange = () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange
    );

    // Check for updates periodically (every 60 seconds)
    const interval = setInterval(() => {
      registration?.update().catch(() => {});
    }, 60_000);

    return () => {
      clearInterval(interval);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
    };
  }, []);

  const applyUpdate = useCallback(() => {
    if (waitingWorker) {
      waitingWorker.postMessage("SKIP_WAITING");
    }
  }, [waitingWorker]);

  return { updateAvailable, applyUpdate };
}
