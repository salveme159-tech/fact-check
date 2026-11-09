// Shared API URL helpers for the web app and financial client.
const configuredBase = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
export const apiBaseUrl = configuredBase.replace(/\/+$/, "");
export function getApiBaseUrl(): string { return apiBaseUrl; }
export function apiUrl(endpoint: string): string {
  return `${apiBaseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}
export async function apiFetch(endpoint: string, options?: RequestInit): Promise<Response> {
  return fetch(apiUrl(endpoint), options);
}
