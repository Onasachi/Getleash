"use client";

/**
 * Supplier names from the owner's private directory, once the owner has signed in (Private page,
 * NEP-413). Until then the pages show each supplier's payment address, which is on-chain anyway.
 */
import { useEffect, useState } from "react";

export function useSupplierNames(): { names: Map<number, string>; available: boolean } {
  const [names, setNames] = useState<Map<number, string>>(new Map());
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/private/names", { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as { names: Record<string, string> }) : null))
      .then((body) => {
        if (cancelled || !body) return;
        setNames(new Map(Object.entries(body.names).map(([id, name]) => [Number(id), name])));
        setAvailable(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return { names, available };
}
