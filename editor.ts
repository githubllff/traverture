// Apply the shared external-link opener in the existing JW-link click handler:
// 1. Build the existing `url` exactly as before.
// 2. Call `window.open(url, "_blank", "noopener,noreferrer")` first.
// 3. If it returns a falsy value, fall back to Electron shell.openExternal(url).
// 4. Do not use Electron as the primary opener.
