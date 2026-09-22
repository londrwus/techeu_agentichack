// Navigation for code that runs outside React components (the scan store, map marker handlers).
// App registers React Router's navigate() here, so every jump stays a client-side route change.
let navigate = null;

export function setNavigate(fn) { navigate = fn; }

/** Go to an app path like "/mission". Falls back to a full page load before the router is up. */
export function go(path) {
  if (navigate) navigate(path);
  else window.location.assign(path);
}
