import { createContext, useContext } from "react";
import type { User } from "@streamshield/shared";
export interface Auth {
  user: User | null;
  csrf: string;
  loading: boolean;
  error: string | null;
  heartbeatMs: number;
  refresh: () => Promise<unknown>;
  call: <T>(path: string, options?: RequestInit) => Promise<T>;
}
export const AuthContext = createContext<Auth | null>(null);
export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("AuthProvider is required");
  return auth;
}
