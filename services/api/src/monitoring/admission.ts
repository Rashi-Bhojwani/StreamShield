// Read-only monitoring must remain observable during Redis loss. Authentication still uses fresh DB sessions.
export function localAdmission(limit = 120, windowMs = 60000, capacity = 100) {
  const clients = new Map<string, { start: number; count: number }>();
  return (identity: string, now = performance.now()) => {
    for (const [key, value] of clients)
      if (now - value.start >= windowMs) clients.delete(key);
    let value = clients.get(identity);
    if (!value) {
      if (clients.size >= capacity) return false;
      value = { start: now, count: 0 };
      clients.set(identity, value);
    }
    value.count++;
    return value.count <= limit;
  };
}
