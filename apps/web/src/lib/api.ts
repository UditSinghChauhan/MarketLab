import type { ApiError } from "@marketlab/contracts";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function isApiError(body: unknown): body is ApiError {
  return typeof body === "object" && body !== null && "error" in body;
}

/** JSON fetch with the session token. 4xx responses that carry a body are returned to the caller via `allow`. */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null; allow?: number[] } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => null);
  if (response.ok || options.allow?.includes(response.status)) return body as T;

  const code = isApiError(body) ? body.error.code : "http_error";
  const message = isApiError(body)
    ? body.error.message
    : `Request failed (${String(response.status)})`;
  throw new ApiRequestError(response.status, code, message, body);
}
