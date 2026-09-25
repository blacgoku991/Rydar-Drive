import { useEffect, useState } from "react";

/** Horloge qui se rafraîchit périodiquement (« il y a 6 min », expirations). */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
