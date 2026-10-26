# X Mute Bag

Pick words directly from posts on X, review them in a small bag, and add them to X’s muted words.

## Install

No build, account, or API key is needed.

1. Open **chrome://extensions** (or **brave://extensions** in Brave).
2. Enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`.
3. Pin **X Mute Bag** from the browser’s Extensions menu.
4. Open or refresh **https://x.com/home**, then click the bag icon.

The packaged version is also available in `dist/x-mute-bag.zip`. Extract it and load the extracted folder, not the ZIP. Keep the folder in place while the extension is installed.

After updating these files, click **Reload** on the extension’s card and refresh open X tabs.

## Use

- Click the toolbar icon to start picking. Hover over a tweet word to preview it, then click to add it. Repeated words are collected once.
- To pick a phrase or full name, click its first word and **Shift-click** its last word in the same post. Holding Shift previews the full range. This replaces the word just picked with one phrase; further Shift-clicks adjust that phrase. You can select forwards or backwards. Independently collected or manually edited entries stay in the bag.
- Expand or collapse the bag at the top right. Edit entries, remove individual words, or type a complete phrase.
- Press **Escape** to stop picking. Closing the panel keeps the bag; clicking the toolbar icon reopens it.
- The default is **forever**, in **Home timeline and notifications from anyone**. Expand the settings line to change these options for the entire batch.
- Click **Apply**. A separate background tab saves entries one at a time, while your original feed stays in place.
- Words already muted are skipped without changing their settings. Successfully confirmed entries leave the bag.
- **Stop** prevents further saves; a save already in flight may finish. **Resume / retry** checks X’s list before continuing. **End batch** releases the remaining bag for editing. Previously saved words stay muted.

If the browser closes during a batch, reopen the bag and resume explicitly. The extension also pauses if the signed-in account changes. Bags are stored separately by X handle.

## Compatibility and privacy

Current desktop Chrome/Chromium; Manifest V3, Chrome 120 or newer. X’s settings must be in English for this version. Tweet words support Unicode and multilingual text.

Only tweet bodies are selectable, including replies and quotes. Image text, author names, menus, and composer fields are excluded. Pick phrases with Shift-click within one tweet body, or enter and edit them in the bag.

The extension uses X’s normal settings interface. It does not call undocumented X endpoints, read cookies, send tweet content to a server, or require an API key. Only local bag/preferences/batch state is stored; Chrome sync is not used. Its permissions are `storage`, `scripting`, and `https://x.com/*`.

X may change its interface. When required controls cannot be recognized or a save cannot be confirmed, the batch pauses instead of guessing. Open **Settings tab** to inspect X’s message, then retry or end the batch. X’s own muting behavior still applies; search results can contain muted terms.

## Development and checks

The runtime is plain JavaScript and CSS with no build step or runtime dependencies. `core.js` provides normalization and queue helpers; `background.js` owns persisted state and tabs; `x-adapter.js` isolates X’s DOM assumptions; `content.js` owns the picker, panel, and form driver.

```sh
npm ci
npx playwright install chromium
npm run check
npm run package
```

Unit and worker tests can run without installing dependencies:

```sh
node --test tests/core.test.cjs tests/background.test.cjs
```

Browser tests load the real unpacked extension in a fresh Chromium profile and intercept all X requests with local fixtures. They never access a signed-in X account. To use an existing compatible Chromium executable, set `XMB_BROWSER`; set `XMB_HEADED=1` for a visible window.

For an environment where browser launch is restricted, `node tests/mcp-harness.cjs` builds `artifacts/mcp-harness.js`. Evaluate that script in a blank Chrome MCP test page, then call `XMBTest.selection()`, `XMBTest.phrases()`, `XMBTest.apply()`, `XMBTest.failures()`, and `XMBTest.stopAndAccount()`. This harness runs the unchanged production scripts with simulated Chrome APIs and X responses; it does not replace testing extension installation.

`node tests/live-preview.cjs` builds a temporary picker preview for a disposable live X tab. Its bridge rejects Apply, and its bag is held only in memory. Close that tab after inspection.

Regenerate the included icons with `node scripts/icons.cjs`. Package only runtime files and this guide with `npm run package`.

## Verification in this workspace

- Unit and worker checks cover Unicode normalization, duplicates, phrase editing, queue checkpoints, origin/tab checks, concurrent requests, stopping, uncertain saves, and worker/browser restarts.
- Chrome MCP fixture checks cover actual DOM ranges and highlights, Shift-click phrases and full names, reverse ranges, rapidly repeated clicks, dynamically loaded tweets, controlled inputs, sequential saves, options, partial failures, retries, closed tabs, and account changes.
- Live X checks verified three clickable words and highlights, unchanged feed navigation, all English form controls, muted-list recognition, and a temporary draft value accepted by React. The draft was restored without clicking Save.
- Live X Shift-click checks confirmed that a multiword range becomes one highlighted bag entry without navigating away or saving account settings.
- Launching a separate browser was blocked by the workspace environment. Chrome MCP also prohibits extension-management pages. The unpacked-extension Playwright suite remains available to run after local setup; installation and a real account save were not performed here.
