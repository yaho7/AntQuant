/**
 * Thin fetch wrapper. The session lives in an HttpOnly cookie; state-changing
 * requests carry the CSRF token returned by /api/auth/me.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) {
      return body.detail
        .map((d: { loc?: unknown[]; msg?: string }) =>
          `${(d.loc ?? []).slice(1).join(".")}: ${d.msg ?? "invalid"}`.replace(/^: /, ""),
        )
        .join("; ");
    }
  } catch {
    /* not JSON */
  }
  return `${res.status} ${res.statusText || "Request failed"}`;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers.set("Content-Type", "application/json");
  if (method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Cannot reach the LumiBot UI server.");
  }
  if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, await parseError(res));
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, form),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
