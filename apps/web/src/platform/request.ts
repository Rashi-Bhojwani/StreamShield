import { config } from "../config";
export class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function platformRequest<T>(
  path: string,
  options: RequestInit = {},
  csrf?: string,
): Promise<T> {
  const response = await fetch(config.VITE_API_BASE_URL + path, {
    credentials: "include",
    signal: AbortSignal.timeout(config.VITE_API_TIMEOUT_MS),
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok)
    throw new RequestError(
      response.status,
      body?.error?.message || "The request could not be completed.",
    );
  return body as T;
}
