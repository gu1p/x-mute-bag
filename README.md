# X Mute Bag

Pick words directly from posts on X, review them in a small bag, and add them to X’s muted words. The extension also hides matching posts itself, including posts quoting muted text, and can hide replies from selected accounts while keeping their original posts.

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
- The main panel shows your bag and **Apply**. Open **More options** only when you need import/export, mute settings, or timeline filters; each section opens separately. Picking instructions appear while picking, and batch errors and extra actions stay under **Details**.
- Open **More options → Import words** to paste a list or choose **Load .txt file**. Use one word or complete expression per line, then click **Add lines to bag**. File loading lets you review the text first. Imports merge with your bag; they do not replace it or save to X until you click **Apply**.
- Imports accept UTF-8 text up to 1 MB, including Windows and macOS line endings. Blank lines are ignored, surrounding/repeated whitespace is cleaned, and duplicates are skipped case-insensitively. Hashtags, usernames, punctuation, and spaces within an expression stay together. Each entry must be at most 280 characters; an invalid line is reported by number and nothing is imported until you fix it.
- Open **More options → Export words** and use **Copy text** or **Download .txt** to export one entry per line. Choose **Bag only** for pending entries, or **Muted words + bag** for the last synced X muted words plus pending entries, with duplicates removed. Use **Sync muted words** under **Timeline filters** first for an up-to-date backup; the export shows when the list was last synced and excludes known expired mutes. Text exports contain words only, not mute settings or account reply rules. Reimporting uses the bag’s current batch settings when you Apply.
- Press **Escape** to stop picking. Closing the panel keeps the bag; clicking the toolbar icon reopens it.
- The default is **forever**, in **Home timeline and notifications from anyone**. Open **More options → Mute settings** to change these options for the entire batch.
- Click **Apply**. A separate background tab saves entries one at a time, while your original feed stays in place. It uses X’s Add link to keep the app loaded and proceeds as soon as each save is confirmed, without a fixed delay between successful entries. Retry delays apply only after a failure.
- Words already muted are skipped without changing their settings. Successfully confirmed entries leave the bag.
- **Hide muted posts, including quotes** runs automatically, even with the bag closed. If a post or any quoted body contains a muted word or phrase, the entire outer post disappears from the page. This also covers tweets loaded while scrolling.
- Existing X muted words are imported in a temporary background settings tab. **Sync muted words** refreshes the list immediately; the extension also refreshes it automatically about every ten minutes while X is open. Opening X’s muted-word settings imports edits there as well.
- The local word filter applies to rendered posts across X, including Home, profiles, search, and replies. Its toggle is independent of X’s Home/notification options and uses all imported muted words. Turn it off to restore posts hidden by word matches; X’s own filters and your account rules remain in effect.
- Under **More options → Timeline filters → Account filters**, enter an **@username** or paste an **X profile link**, then click **Add**. Suggestions include authors on the current page. The rule immediately hides that account’s replies to other accounts from feeds, including attached conversation context. Original posts, quote posts, and self-threads stay visible unless a separate word rule matches them.
- Each account rule has a checkbox to pause/resume it and an **×** to remove it. Rules are saved locally, separately for each signed-in X account, and work with the panel closed. They do not mute, block, or unfollow anyone on X, and do not require **Apply** or a muted-word sync. Open a post directly to read its conversation without the account reply filter.
- Failed saves retry automatically, with no attempt limit. Delays start at 30 seconds and increase to a maximum of five minutes per failed entry; successful progress resets the delay. Every retry checks X’s list first, including when an earlier save may have succeeded despite an error. The compact status shows the next attempt; expand **Details** for the error, **Retry now**, **Settings tab**, or **End batch**.
- **Stop** cancels automatic retries and prevents further saves; a save already in flight may finish. After an intentional Stop, use **Resume / retry** to continue. **End batch** releases the remaining bag for editing. Previously saved words stay muted.

Automatic retries work with the panel closed and resume after browser or extension-worker restarts. A closed or unresponsive settings tab is recovered automatically. Use **Stop** to stop a batch, rather than closing its settings tab. Chrome may delay scheduled attempts while the device is asleep or busy. If the signed-in account changes or you are signed out, the extension keeps retrying but never saves for a different account; switch back or sign in to the batch’s original account to let it continue. Bags are stored separately by X handle.

## Compatibility and privacy

Current desktop Chrome/Chromium; Manifest V3, Chrome 120 or newer. X’s settings must be in English for this version. Tweet words support Unicode and multilingual text.

Only tweet bodies are selectable, including replies and quotes. Image text, author names, menus, and composer fields are excluded. Pick phrases with Shift-click within one tweet body, or enter and edit them in the bag.

The extension uses X’s normal settings interface. It does not call undocumented X endpoints, read cookies, send tweet content to a server, or require an API key. The local bag, preferences, batch state, muted-word cache, and account reply rules are stored per X handle in **chrome.storage.local**, the extension’s local data store. Chrome sync is not used. Account rules remain until you disable or remove them; clearing extension data or uninstalling removes them. Its permissions are `storage`, `scripting`, `alarms` (for automatic retries and stalled-tab recovery), and `https://x.com/*`.

Matching is case-insensitive, respects word boundaries, and treats a selected expression as one phrase. For example, `cat` matches `cat` and `#cat`, but not `catapult`; `John Smith` does not match `John Smithson`. Quote bodies are checked separately, so a phrase cannot accidentally span two different posts. Hidden cells remain in X’s DOM to avoid disrupting its rendering and are restored if X reuses them for unrelated tweets.

Only rendered posts are inspected. The word filter cannot read text inside pictures or inside a quote X has not loaded. Unmuting elsewhere is reflected on the next sync. Durations set through the extension are tracked locally; imported timed mutes follow the refreshed native list. Cached muted words stop being used after fifteen minutes without a successful refresh, so a failed sync cannot keep hiding unmuted content indefinitely. Account reply rules do not expire with this cache.

Reply detection uses X’s English reply metadata or the avatar connector lines between adjacent timeline cells. It only hides parent context when the filtered reply ends that connected conversation item; context needed by a visible downstream reply stays. If the parent/recipient cannot be identified, or X changes the layout, the post stays visible rather than treating an original post as a reply. This includes a reply whose parent has already scrolled out of X’s rendered DOM and which has no recipient label. Quoted reply metadata does not classify the outer post as a reply.

X may change its interface. When required controls cannot be recognized or a save cannot be confirmed, the batch keeps retrying without guessing at controls or marking the entry saved. Expand batch **Details → Settings tab** to inspect X’s message; use **Stop** or **End batch** if an entry needs correction. X’s own muting behavior still applies; search results can contain muted terms.

## Development and checks

The runtime is plain JavaScript and CSS with no build step or runtime dependencies. `core.js` provides normalization, matching and queue helpers; `background.js` owns persisted state and tabs; `x-adapter.js` isolates X’s DOM assumptions; `filter.js` watches the timeline and syncs mute rules; `content.js` owns the picker, panel, and form driver.

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

Browser tests load the real unpacked extension in a fresh Chromium profile and route X to a local HTTPS fixture server, including the first navigation of extension-created tabs. Other hostnames are blocked in that test browser. They never access a signed-in X account. OpenSSL must be available to generate a temporary test certificate; no certificate is installed in your system trust store. To use an existing compatible Chromium executable, set `XMB_BROWSER`; set `XMB_HEADED=1` for a visible window.

For an environment where browser launch is restricted, `node tests/mcp-harness.cjs` builds `artifacts/mcp-harness.js`. Evaluate that script in a blank Chrome MCP test page, then call `XMBTest.replies()`, `XMBTest.filtering()`, `XMBTest.selection()`, `XMBTest.phrases()`, `XMBTest.apply()`, `XMBTest.failures()`, and `XMBTest.stopAndAccount()`. This harness runs the unchanged production scripts with simulated Chrome APIs and X responses; it does not replace testing extension installation.

`node tests/live-preview.cjs` builds a temporary picker preview for a disposable live X tab. Its bridge rejects Apply, and its bag is held only in memory. Close that tab after inspection.

Regenerate the included icons with `node scripts/icons.cjs`. Package only runtime files and this guide with `npm run package`.

## Verification in this workspace

- Unit and worker checks cover Unicode normalization, duplicates, phrase editing, text import validation and export round trips, queue checkpoints, origin/tab checks (including route changes without document reloads), concurrent requests, unlimited retries with capped delays, stalled/closed tabs, stale callbacks, Stop/End cancellation, uncertain saves, and worker/browser restarts.
- Chrome MCP fixture checks cover actual DOM ranges and highlights, Shift-click phrases and full names, reverse ranges, rapidly repeated clicks, dynamically loaded tweets, controlled inputs, sequential saves, options, partial failures, retries, closed tabs, and account changes.
- Live X checks verified three clickable words and highlights, unchanged feed navigation, all English form controls, muted-list recognition, and a temporary draft value accepted by React. The draft was restored without clicking Save.
- Live X Shift-click checks confirmed that a multiword range becomes one highlighted bag entry without navigating away or saving account settings.
- Filtering checks cover native mute import, hiding the whole outer quoted post, Unicode/phrase boundaries, new and recycled feed cells, toggling, account isolation, persistence, native unmuting, and stale cache expiry.
- Live X filtering checks confirmed that a match found only in quoted text hides the whole outer timeline cell, preserves X’s DOM and navigation, and is restored when the filter is switched off. These checks used a temporary local rule and did not change account settings.
- Account rule checks cover store migration, duplicate handles, persistence, account isolation, connected parents, original posts, self-threads, quoted metadata, missing or conflicting parent context, recycled authors, new replies, direct conversations, pause/removal, and independence from word-cache expiry. A live X check hid a reply and its connected parent, left an unrelated reply visible, and restored both cells when the temporary rule was removed.
- The full unpacked-extension Chromium suite passes against local HTTPS fixtures. It covers the compact panel and progressive disclosure, a real 30-second automatic retry with the panel closed, uncertain-save reconciliation, Stop cancellation, account-change recovery, paste and file imports, invalid encodings and oversized files, duplicate counts, clipboard and downloaded exports, export scopes, reimporting, persistence, and the existing picker, Apply, and filtering flows. These checks do not save to a real X account.
- `node tests/batch-speed.cjs` measures eight sequential saves against a local fixture, checks that native navigation needs only one document load, and verifies delayed-list duplicate detection and Save redirects that leave Chrome’s sender document URL stale. Fixture timings measure extension overhead, not live X server latency.
