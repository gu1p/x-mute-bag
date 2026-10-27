# X Mute Bag

Filter posts and quotes on X with your own persistent local word list. Pick words from posts or import one word/expression per line. Local filtering works beyond X’s native mute capacity and does not submit words to X.

## Install

No build, account, or API key is needed.

1. Open **chrome://extensions** (or **brave://extensions**).
2. Enable **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`.
3. Pin **X Mute Bag** from the Extensions menu.
4. Open or refresh **https://x.com/home**, then click the bag icon.

`npm run package` creates `dist/x-mute-bag.zip`. Extract it and load the extracted folder. Keep that folder in place while the extension is installed.

After updating, **Reload** the extension and refresh open X tabs.

## Filter locally

- Click the toolbar icon, then click words in posts to collect them. Click the first word and **Shift-click** the last word to collect a phrase, including across inline spans. Repeated clicks and imports deduplicate case-insensitively.
- Type expressions directly into the bag, or open **More options → Import words** to paste text or load a UTF-8 `.txt` file. Use one word or expression per line. Imports merge with the bag for review; they do not change X settings.
- Click **Filter N words**. The entire bag is saved to the local filter immediately and matching posts disappear. There is no native mute queue or delay between entries. Drafts stay visible until you apply them, so phrase picking is not interrupted by a disappearing post.
- Saved filters work with the panel closed and after browser restarts. They are permanent until removed, stored separately for each signed-in X account. Native mute settings and cache expiry cannot erase them.
- Open **More options → Saved filters** to search and remove words. Removing a local rule restores posts unless another local rule, an account rule, or a native X mute still applies. Saved-list search displays up to 50 matches; large bags reveal 100 entries at a time to keep the panel responsive.
- Open **More options → Timeline filters** to pause word filtering and restore posts hidden by it. Reenable it to hide matches again. X’s own muting and account reply rules remain separate.
- Press **Escape** to stop picking, or close/collapse the bag. Your drafts and saved filters remain on this device.

On upgrade, previously known unexpired native mutes, pending bag entries, and the retained batch are copied into the local list once. This preserves words from interrupted or capacity-limited batches. If a native batch is still retrying, **Filter N words** saves its remaining bag locally and ends that native batch; a save already in flight may finish.

## Matching and page behavior

Matching is case-insensitive, Unicode-aware, and literal: accents and punctuation are preserved, and repeated whitespace is normalized. `cat` matches `cat` and `#cat`, but not `catapult` or `@cat`. An expression stays together; `John Smith` does not match `John Smithson`. A prefix tree shares matching work across large dictionaries, and the matcher is rebuilt only when its rules change or expire.

The extension inspects `main article[data-testid="tweet"]` and reads each `[data-testid="tweetText"]` separately, including quote-card text inside `div[role="link"]`. Inline spans, links, line breaks, and emoji image alternatives contribute to the text. A phrase cannot accidentally span a comment and its quote. If either body matches, the outer `[data-testid="cellInnerDiv"]` is hidden when it contains one post; otherwise only the matching article is hidden.

Posts remain in X’s DOM to avoid breaking its rendering. A mutation observer rechecks new posts, expanded text, and cells recycled while scrolling. Previously hidden cells are restored when their content no longer matches. Composer/editable content, dialogs, settings, messages, and sidebars are excluded. Authors and interface labels are not treated as tweet text.

Only rendered text can be inspected. Text inside pictures and text that X has not loaded cannot be matched. Filtering affects this browser/device; it does not block accounts or change the X mobile app.

## Import and export

Imports accept UTF-8 text up to 1 MB, including Windows/macOS line endings. Blank lines are ignored, surrounding/repeated whitespace is cleaned, and duplicates are skipped. Expressions can contain spaces, hashtags, handles, and punctuation. Each entry is limited to 280 Unicode characters. Invalid imports report the original line number and make no partial changes.

Under **More options → Export words**, choose:

- **Saved local filters** for the permanent local database.
- **Bag only** for pending drafts.
- **All words** for local filters, pending drafts, and the last synced nonexpired native mutes, without duplicates.

Use **Copy text** or **Download .txt**. Reimport exported files and click **Filter N words** to restore them. Exports contain words only, not native mute settings or account reply rules. **Sync muted words** under Timeline filters refreshes the native portion of an All words export.

## Optional native X muting

**More options → Mute on X (optional) → Mute bag on X** also submits your bag through X’s normal English settings interface. It saves a local copy first, so every entry still filters locally even when X rejects further native mutes. X’s native capacity and restrictions still apply.

Native options default to forever, Home timeline, and notifications from anyone. These settings affect native X muting only; saved local filters remain permanent. A separate background tab saves sequentially using X’s Add link. There is no fixed wait between successful entries. Existing native words are skipped, confirmed entries leave the bag, and your feed stays in place.

Failed native saves retry indefinitely, starting after 30 seconds and backing off to five minutes. Each retry checks the list before resubmitting an uncertain save. Retries recover from closed/stalled tabs and browser restarts. Account changes or sign-out prevent saves until the original account is restored. Chrome can delay attempts while asleep or busy.

**Stop** cancels retries; **Resume / retry** restarts an intentional stop. Under batch **Details**, use **Retry now**, **Settings tab**, or **End batch**. End releases pending entries for editing. **Filter N words** switches the remaining bag to local filtering and ends native retries. Already saved native words stay muted.

Native muted words are also cached for local filtering and refreshed about every ten minutes while X is open. This temporary cache expires after fifteen minutes without a refresh; saved local filters do not expire. Native unmuting affects the native cache, while a separately saved local rule remains until you remove it.

## Account reply filters

Under **More options → Timeline filters → Account filters**, enter an `@username` or X profile link to hide that account’s replies to other accounts. Original posts, quote posts, and self-threads remain visible unless a word rule matches them. Rules apply immediately on this device and do not mute, block, or unfollow anyone on X.

Reply detection uses English reply metadata or connected avatar lines between adjacent timeline cells. Context needed by another visible reply is preserved. Ambiguous posts remain visible, and directly opened conversations stay readable. Each rule can be paused or removed separately.

## Compatibility and privacy

Desktop Chrome/Chromium 120 or newer; Manifest V3. Local word matching supports multilingual text. Optional native settings automation and reply metadata detection expect X’s English interface.

The extension does not call undocumented X endpoints, read cookies, send post content to a server, use analytics, or require an API key. Drafts, saved local words, preferences, batch state, native mute cache, and reply rules stay in **chrome.storage.local**, keyed by X handle. Chrome sync is not used. Uninstalling or clearing extension data removes this database; export it for backup.

Permissions: `storage`, `scripting`, `alarms` for native retry recovery, and access to `https://x.com/*`.

## Development and verification

Runtime files are plain JavaScript/CSS with no build step or runtime dependencies. `core.js` owns normalization, dictionary matching, and queue helpers; `background.js` owns persisted state and native tabs; `x-adapter.js` isolates X’s DOM structure; `filter.js` watches posts; `content.js` owns the panel, picker, and native form driver.

```sh
npm ci
npx playwright install chromium
npm run check
npm run package
```

Unit/worker checks need no dependencies:

```sh
node --test tests/core.test.cjs tests/background.test.cjs
```

Browser checks load the actual unpacked extension in fresh Chromium profiles. A local HTTPS fixture server receives all X traffic, including extension-created tabs; other hostnames are blocked. They do not access a signed-in X account. OpenSSL generates a temporary test certificate without installing it in system trust. Set `XMB_BROWSER` to use an existing compatible executable, or `XMB_HEADED=1` for the main browser suite’s visible window.

- Core/worker tests cover 10,000-term matching, 5,000-word local storage, migration, persistence, account isolation, native sync independence, imports/exports, native checkpoints, automatic retries, and cancellation.
- `tests/local-filter.cjs` exercises 5,002 local words with 200 native mutes already present, whole-post/quote hiding, Unicode and emoji, false positives, editable exclusions, new/recycled cells, disabling, removal, native sync, exports, reloads, and account switching. It verifies that local filtering never submits a native save.
- `tests/browser.cjs` covers the picker, phrase editing, native muting/retry controls, account reply filters, text import/export, and progressive disclosure.
- `tests/batch-speed.cjs` checks native navigation and reports fixture save timing. It covers delayed lists and same-document route changes without false retry delays. Fixture timings measure extension overhead, not live X server latency.

Chrome MCP inspection of live X confirmed the article, text-block, quote-card, and outer-cell structure used by the local fixtures. A reversible live DOM check hid the whole quote-containing cell while keeping the article connected, then restored it. No native settings were changed, and no live post text or account data is included in the fixtures.

`node tests/mcp-harness.cjs` builds `artifacts/mcp-harness.js` for a blank Chrome MCP page when Chromium launch is restricted. `node tests/live-preview.cjs` builds an in-memory picker preview that rejects native writes. Temporary files under `artifacts/` and generated packages under `dist/` are ignored by Git.
