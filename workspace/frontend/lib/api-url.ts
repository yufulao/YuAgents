export function getApiUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  const remoteRelayMode =
    process.env.NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED === 'false' &&
    process.env.NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED === 'false';
  if (remoteRelayMode) {
    return typeof window !== 'undefined' ? window.location.origin : '';
  }
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return 'http://127.0.0.1:8000';
}
