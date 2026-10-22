# tra.VER:ture Security and Privacy

If you are concerned about the "Scorecard" review or the "Caution" warning on the [Obsidian Community plugins page](https://community.obsidian.md/plugins/traverture), here is some information to ease your mind.

---

## Network Use

This plugin fetches scripture text from the official *jw.org* API when displaying verse previews or inserting citations. No data is sent; only scripture BCV codes are used in the URL to retrieve verse content. Fetched content is cached locally in memory for 1 hour.

No other network requests are made. **No telemetry, tracking, or third-party services** are used. **No HTML web-scraping** is involved.

---

## Privacy

This plugin writes to the system clipboard only when you click a COPY button (to copy scripture text or table data). **No clipboard data is ever read. No data is collected, stored, or transmitted**.

---

## WASM Module

This plugin includes a WebAssembly (WASM) binary compiled from Rust. The WASM module contains the scripture reference parsing engine; it finds and converts Bible references into structured BCV codes. It also contains book name data for all supported languages. It is based on my [linkture](https://github.com/erykjj/linkture) project.

The WASM module:
- Does not make any network requests
- Does not access the file system
- Does not read or modify DOM directly

---

## CSS

The plugin uses `!important` CSS flags in a few places to override Obsidian's default sidebar and button styles. This is necessary because Obsidian's built-in styles are highly specific and would otherwise break the plugin's table and modal layouts. No `!important` flags affect anything outside the plugin's own interface elements (sidebar, modal, and inline links).

---

## TypeScript Warnings

The plugin source contains TypeScript strictness warnings. **These warnings are cosmetic and do not affect functionality or security**. All external data (API responses) is validated before use.