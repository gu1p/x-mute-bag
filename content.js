(() => {
  'use strict';
  if (globalThis.__xMuteBagInstalled) return;
  globalThis.__xMuteBagInstalled = true;
  const C = XMuteCore;
  const X = XMuteX;
  let host, shadow, state, active = false, collapsed = false, visible = false;
  let records = [], hover = null, refreshFrame = 0, refreshTimer = 0;
  let anchor = null, shiftHeld = false, pickGeneration = 0, pickQueue = Promise.resolve();
  let runnerBusy = false, runnerQueued = false, cancelledJob = null, notice = '';
  const runnerWaiters = new Set();
  let transferBusy = false;
  let bagLimit = 100;
  const locked = () => C.activeJob(state?.job);
  async function request(type, fields = {}) {
    const reply = await chrome.runtime.sendMessage({type, account: X.account(), ...fields});
    if (!reply?.ok) throw new Error(reply?.error || 'The extension was reloaded. Refresh this X tab.');
    return reply.value;
  }
  async function refresh() {
    const account = X.account();
    if (!account) {
      state = null;
      if (visible) setNotice('Open X and sign in to pick words.');
      setPicking(false);
      render();
      return;
    }
    if (state && state.account !== account) setPicking(false);
    state = await request('view');
    if (visible) render();
    scheduleRanges();
  }
  function setNotice(message) {
    notice = message;
    const box = shadow?.querySelector('#notice');
    if (box) { box.textContent = notice; box.hidden = !notice; }
  }
  async function action(type, fields = {}) {
    try {
      const next = await request(type, fields);
      if (next.account !== X.account()) { await refresh(); return false; }
      state = next;
      if (type === 'clear') anchor = null;
      setNotice('');
      render();
      scheduleRanges();
      return next;
    } catch (error) { setNotice(error.message); return false; }
  }
  function transferStatus(message, error = false, exporting = false) {
    const box = shadow.getElementById(exporting ? 'export-status' : 'transfer-status');
    box.textContent = message;
    box.className = error ? 'notice' : 'hint';
  }
  function renderTransfer() {
    const $ = id => shadow.getElementById(id);
    const account = X.account();
    const available = !!state && state.account === account;
    if ($('transfer').dataset.account !== (account || '')) {
      $('transfer').dataset.account = account || '';
      bagLimit = 100;
      $('local-search').value = '';
      $('import-text').value = '';
      $('import-file').value = '';
      transferStatus('');
      transferStatus('', false, true);
    }
    const disabled = !available || locked() || transferBusy;
    $('import-text').disabled = disabled;
    $('load-text').disabled = disabled;
    $('import-file').disabled = disabled;
    $('import-text-button').disabled = disabled || !$('import-text').value.trim();
    for (const id of ['export-scope', 'copy-text', 'download-text']) $(id).disabled = !available || transferBusy;
    const syncedAt = available && state.filter?.syncedAt;
    $('export-hint').textContent = $('export-scope').value === 'local' ? 'Your permanent local filters, with no native X limit.' : $('export-scope').value === 'bag' ? 'Pending entries only.' :
      (syncedAt ? 'Last synced ' + new Date(syncedAt).toLocaleString() + '. ' : 'Muted words have not been synced yet. ') +
      'Refresh under Timeline filters for the latest list.';
  }
  function renderLocalWords() {
    const $ = id => shadow.getElementById(id), words = state?.localWords || [];
    $('local-summary').textContent = 'Saved filters' + (words.length ? ' · ' + words.length : '');
    if (!$('local-tools').open) return;
    const query = C.key($('local-search').value);
    const matches = words.filter(word => word.key.includes(query)), shown = matches.slice(0, 50);
    $('local-info').textContent = matches.length ? 'Showing ' + shown.length + ' of ' + matches.length + ' filters.' : 'No saved filters found.';
    const signature = JSON.stringify([state?.account, shown]);
    if ($('local-words').dataset.signature === signature) return;
    $('local-words').replaceChildren(...shown.map(word => {
      const li = document.createElement('li'); li.className = 'rule';
      const text = document.createElement('span'); text.textContent = word.text; text.style.flex = '1';
      const remove = document.createElement('button'); remove.textContent = '×';
      remove.setAttribute('aria-label', 'Remove local filter ' + word.text);
      remove.onclick = () => action('local:remove', {id: word.id});
      li.append(text, remove); return li;
    }));
    $('local-words').dataset.signature = signature;
  }
  async function exportWords(copy) {
    if (transferBusy || !state || state.account !== X.account()) return;
    const account = state.account, scope = shadow.getElementById('export-scope').value;
    transferBusy = true; renderTransfer();
    try {
      await pickQueue;
      if (X.account() !== account) throw new Error('The X account changed. Try exporting again.');
      const result = await request('text:export', {account, scope});
      if (X.account() !== account) throw new Error('The X account changed. Try exporting again.');
      if (!result.count) throw new Error('No words to export. Add entries or sync muted words first.');
      if (copy) {
        try { await navigator.clipboard.writeText(result.text); }
        catch { throw new Error('Could not copy text. Use Download .txt to export your words.'); }
      } else {
        const url = URL.createObjectURL(new Blob([result.text], {type: 'text/plain;charset=utf-8'}));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'x-mute-bag-' + account + '-' + scope + '.txt';
        shadow.append(link);
        link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      transferStatus(result.count + (result.count === 1 ? ' entry ' : ' entries ') + (copy ? 'copied.' : 'exported.'), false, true);
    } catch (error) { transferStatus(error.message, true, true); }
    finally { transferBusy = false; renderTransfer(); }
  }
  function createPanel() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'x-mute-bag';
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483646;color-scheme:light dark;';
    shadow = host.attachShadow({mode: 'open'});
    shadow.innerHTML = [
      '<style>',
      ':host{all:initial;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf2}',
      '*{box-sizing:border-box} [hidden],:host([hidden]){display:none!important}',
      '.panel{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;width:min(354px,calc(100vw - 32px));background:#151b24;color:#e8edf2;border:1px solid #344052;border-radius:18px;box-shadow:0 18px 60px #0006;overflow:hidden}',
      'header{display:flex;align-items:center;gap:10px;padding:15px 16px} .mark{display:grid;place-items:center;width:31px;height:31px;border-radius:10px;background:#b8f4da;color:#183f32;font-size:19px;font-weight:800}',
      'h2{margin:0;font-size:15px;letter-spacing:-.2px} .identity{font-size:11px;color:#a0adbe} .heading{flex:1}',
      '#count{display:inline-block;min-width:21px;margin-left:3px;padding:1px 6px;border-radius:10px;background:#ffffff0c;font-size:11px;text-align:center}',
      'button,input,select,textarea{font:inherit} button{cursor:pointer;border:1px solid #465368;border-radius:9px;background:transparent;color:inherit;padding:7px 10px} button:hover{background:#ffffff12} button:disabled{opacity:.42;cursor:default}',
      'button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #79ddba;outline-offset:3px}',
      '.icon{padding:4px 8px;border:0;font-size:18px}.body{border-top:1px solid #344052;padding:14px 16px;max-height:calc(100vh - 105px);overflow:auto}',
      '.pick{width:100%;text-align:left;border-color:#466b60;background:#b8f4da0c}.pick[aria-pressed=true]{border-color:#8fe4c0;color:#b8f4da}.hint{color:#a0adbe;font-size:12px;margin:8px 0 12px}',
      '.empty{padding:16px 0 6px;color:#a0adbe;text-align:center;font-size:12px}',
      '.entries{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:6px;max-height:224px;overflow:auto}.entry{display:flex;gap:6px;align-items:center}',
      '#more-entries{width:100%;margin-top:6px;border:0;font-size:11px;color:#a0adbe}',
      'input[type=text],select,textarea{min-width:0;background:#0e141c;border:1px solid #465368;border-radius:8px;color:inherit;padding:8px 9px} .entry input{width:100%}.entry button{border:0;padding:7px}.entry input:disabled{opacity:.7}',
      '.add{display:flex;gap:7px;margin-top:10px}.add input{flex:1;width:100%}.add button{padding:7px 12px}',
      '.tools{display:flex;justify-content:flex-end;margin:5px 0 0;color:#a0adbe;font-size:11px}.tools button{border:0;padding:2px 0;font-size:11px}',
      '.filter{padding-top:12px;font-size:12px}.filter label{display:flex;align-items:center;gap:6px}.filter button{font-size:12px;margin-top:8px}.filter p{margin:7px 0;color:#a0adbe}',
      '.rules{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:7px;max-height:180px;overflow:auto}.rule{display:flex;align-items:center;gap:6px;font-size:12px}.rule label{display:flex;align-items:center;gap:6px;flex:1}.rule button{border:0;padding:3px 7px}.accounts summary{color:inherit;font-weight:600}.accounts .hint{margin-bottom:8px}',
      'details{border-top:1px solid #344052;padding-top:11px;margin-top:12px}summary{cursor:pointer;font-size:12px;color:#a0adbe}.options{display:grid;gap:9px;padding-top:12px;font-size:12px}.options label{display:flex;align-items:center;gap:7px}.options select{margin-left:auto;max-width:195px;font-size:12px}input[type=checkbox]{accent-color:#8fe4c0}',
      '.more-options>summary{list-style:none;text-align:center}.more-options>summary::-webkit-details-marker{display:none}.more-options>summary::after{content:"+";float:right}.more-options[open]>summary::after{content:"−"}.more-options details>summary{color:inherit;font-weight:500}.more-options details{padding-top:10px;margin-top:10px}',
      '.apply{margin-top:14px;width:100%;background:#b8f4da;color:#163d2f;border-color:#b8f4da;font-weight:700;padding:10px}.apply:hover{background:#9ee6c8}',
      '.status{margin:10px 0 0;padding:10px 12px;background:#ffffff08;border-radius:10px;font-size:12px;overflow-wrap:anywhere}.status-heading{display:flex;align-items:center;gap:8px}.status-heading>div:first-child{flex:1;min-width:0}.status-heading .batch-actions{margin:0}.status .hint{font-size:11px;margin:3px 0 0}.status details{border:0;padding-top:0;margin-top:7px}.status details summary{font-size:11px}.progress{height:3px;background:#344052;border-radius:3px;margin:9px 0}.bar{height:100%;background:#8fe4c0;border-radius:3px;transition:width .2s}',
      '.batch-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}.batch-actions button{font-size:12px;padding:5px 9px}.notice{font-size:12px;color:#ffd5b5;margin:10px 0 0;overflow-wrap:anywhere}',
      '.transfer summary{color:inherit;font-weight:600}.transfer textarea{display:block;width:100%;resize:vertical;min-height:100px;max-height:240px;font-size:12px}.transfer .export-label{display:grid;gap:6px;margin-top:14px;font-size:12px}.transfer select{width:100%;font-size:12px}.transfer p{overflow-wrap:anywhere}',
      ':host([data-light]) .panel{background:#fff;color:#162521;border-color:#d5dfda;box-shadow:0 14px 60px #10271c22}:host([data-light]) .body,:host([data-light]) details{border-color:#d5dfda}',
      ':host([data-light]) .identity,:host([data-light]) .hint,:host([data-light]) summary,:host([data-light]) .tools,:host([data-light]) .empty{color:#596c63}',
      ':host([data-light]) input[type=text],:host([data-light]) select,:host([data-light]) textarea{background:#f5f8f6;border-color:#c4d0c9}:host([data-light]) button{border-color:#c4d0c9}:host([data-light]) button:hover{background:#00000009}',
      ':host([data-light]) .pick[aria-pressed=true]{color:#146448;border-color:#258665;background:#edf9f2}:host([data-light]) .apply{background:#175e46;color:white}:host([data-light]) .status{background:#f0f5f2}:host([data-light]) .notice{color:#964314}',
      '</style>',
      '<section class="panel" aria-label="X Mute Bag">',
      '<header><div class="mark" aria-hidden="true"><svg width="21" height="21" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h10l1 11H4L5 6ZM7 6V4a3 3 0 0 1 6 0v2M7 11h6"/></svg></div><div class="heading"><h2>Mute bag <span id="count">0</span></h2><div class="identity" id="identity">Words you would rather skip</div></div>',
      '<button class="icon" id="collapse" aria-label="Collapse bag" aria-expanded="true">−</button><button class="icon" id="close" aria-label="Close bag">×</button></header>',
      '<div class="body" id="body"><button class="pick" id="pick" aria-pressed="false">Start picking words</button>',
      '<p class="hint" id="pick-hint" hidden>Shift-click the last word to select a phrase.</p>',
      '<div class="empty" id="empty">Pick a word or add one below.</div><ul class="entries" id="entries" aria-label="Collected words"></ul>',
      '<button id="more-entries" hidden>Show more words</button>',
      '<form class="add" id="add-form"><input id="new-word" type="text" aria-label="Add a word or phrase" placeholder="Add a word or phrase…" maxlength="560" autocomplete="off"><button id="add" type="submit" aria-label="Add entry">+</button></form>',
      '<div class="tools" id="bag-tools"><button id="clear">Clear bag</button></div>',
      '<button class="apply" id="apply">Filter words</button><p class="hint" id="local-status">Filters posts on this device. No X mute limit.</p>',
      '<div class="status" id="status" role="status" aria-live="polite" hidden><div class="status-heading"><div><div id="status-text"></div><p class="hint" id="status-next" hidden></p></div><div class="batch-actions" id="batch-actions"></div></div>',
      '<details id="batch-details"><summary>Details</summary><div class="progress"><div class="bar" id="bar"></div></div><div id="status-counts"></div><p id="status-error"></p><div class="batch-actions" id="batch-extra-actions"></div></details></div>',
      '<details class="more-options" id="more-options"><summary>More options</summary>',
      '<details id="local-tools"><summary id="local-summary">Saved filters</summary><p class="hint">Stored on this device until removed. Native X mutes are separate.</p><input id="local-search" type="text" aria-label="Search saved filters" placeholder="Search saved filters…" autocomplete="off"><p id="local-info" class="hint"></p><ul id="local-words" class="rules" aria-label="Saved local filters"></ul></details>',
      '<div class="transfer" id="transfer"><details id="import-tools"><summary>Import words</summary>',
      '<p class="hint" id="import-hint">One word or expression per line. Blank lines and duplicates are skipped.</p>',
      '<textarea id="import-text" aria-label="Words to import" aria-describedby="import-hint" rows="4" placeholder="spoiler&#10;John Smith&#10;another expression" spellcheck="false"></textarea>',
      '<input id="import-file" type="file" accept=".txt,text/plain" aria-label="Import text file" hidden>',
      '<div class="batch-actions"><button id="load-text">Load .txt file</button><button id="import-text-button">Add lines to bag</button></div>',
      '<p class="hint">Review your bag, then Filter.</p>',
      '<p class="hint" id="transfer-status" role="status" aria-live="polite"></p></details>',
      '<details id="export-tools"><summary>Export words</summary>',
      '<label class="export-label">Export<select id="export-scope" aria-label="Export source"><option value="all">All words</option><option value="local">Saved local filters</option><option value="bag">Bag only</option></select></label>',
      '<p class="hint" id="export-hint"></p><div class="batch-actions"><button id="copy-text">Copy text</button><button id="download-text">Download .txt</button></div>',
      '<p class="hint">Words only; settings and account rules are not included.</p>',
      '<p class="hint" id="export-status" role="status" aria-live="polite"></p></details></div>',
      '<details id="mute-options"><summary id="summary">Mute on X (optional)</summary><p class="hint">Also send the bag to X’s native mute list. X’s own limit applies.</p><div class="options">',
      '<label><input type="checkbox" id="home">Home timeline</label><label><input type="checkbox" id="notifications">Notifications</label>',
      '<label>From<select id="audience" aria-label="Notification audience"><option value="anyone">Anyone</option><option value="unfollowed">People you don’t follow</option></select></label>',
      '<label>Duration<select id="duration" aria-label="Mute duration"><option value="forever">Forever</option><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option></select></label>',
      '</div><div class="batch-actions"><button id="mute-on-x">Mute bag on X</button></div></details><details id="filter-settings"><summary>Timeline filters</summary>',
      '<div class="filter"><label><input id="filter-enabled" type="checkbox" checked>Hide muted posts, including quotes</label><p id="filter-info" role="status"></p><button id="sync-muted">Sync muted words</button></div>',
      '<details class="accounts" id="account-settings"><summary>Account filters <span id="reply-count"></span></summary><p class="hint">Hide replies to other accounts. Keep original posts and self-threads.</p>',
      '<form class="add" id="reply-form"><input id="reply-handle" type="text" aria-label="Hide replies from account" placeholder="@username or X profile link" list="reply-suggestions" autocomplete="off" maxlength="200"><datalist id="reply-suggestions"></datalist><button id="reply-add" type="submit">Add</button></form>',
      '<ul class="rules" id="reply-rules" aria-label="Accounts whose replies are hidden"></ul><p class="hint">Applies immediately · This device only</p></details></details></details>',
      '<p class="notice" id="notice" role="alert" hidden></p></div></section>',
    ].join('');
    document.documentElement.append(host);
    const $ = id => shadow.getElementById(id);
    $('close').onclick = () => { visible = false; host.hidden = true; setPicking(false); };
    $('collapse').onclick = () => { collapsed = !collapsed; render(); };
    $('pick').onclick = () => setPicking(!active);
    $('clear').onclick = () => action('clear');
    $('more-entries').onclick = () => { bagLimit += 100; render(); };
    $('local-tools').ontoggle = renderLocalWords;
    $('local-search').oninput = renderLocalWords;
    $('import-text').oninput = () => { transferStatus(''); renderTransfer(); };
    $('export-scope').onchange = () => { transferStatus('', false, true); renderTransfer(); };
    $('load-text').onclick = () => $('import-file').click();
    $('import-file').onchange = async () => {
      const file = $('import-file').files[0], account = X.account();
      $('import-file').value = '';
      if (!file || transferBusy) return;
      transferBusy = true; renderTransfer();
      try {
        if (file.size > C.TEXT_LIMIT) throw new Error('Keep imports to 1 MB of UTF-8 text or less.');
        let text;
        try { text = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer()); }
        catch { throw new Error('Could not read this file. Choose a UTF-8 text file.'); }
        if (X.account() !== account) throw new Error('The X account changed. Load the file again.');
        $('import-text').value = text;
        transferStatus(file.name + ' loaded. Review the text, then add it to your bag.');
      } catch (error) { transferStatus(error.message, true); }
      finally { transferBusy = false; renderTransfer(); }
    };
    $('import-text-button').onclick = async () => {
      if (transferBusy || locked() || !state || state.account !== X.account()) return;
      const text = $('import-text').value, account = state.account;
      transferBusy = true; renderTransfer();
      try {
        await pickQueue;
        if (X.account() !== account) throw new Error('The X account changed. Try importing again.');
        const result = await action('text:import', {text, account});
        if (!result) { transferStatus(notice || 'The X account changed. Try importing again.', true); setNotice(''); return; }
        $('import-text').value = '';
        transferStatus(result.imported.added + ' added to bag · ' + result.imported.duplicates + ' duplicates skipped. Review your bag, then Filter.');
      } catch (error) { transferStatus(error.message, true); }
      finally { transferBusy = false; renderTransfer(); }
    };
    $('copy-text').onclick = () => exportWords(true);
    $('download-text').onclick = () => exportWords(false);
    $('filter-enabled').onchange = () => XMuteTimeline.setEnabled($('filter-enabled').checked).catch(error => setNotice(error.message));
    $('sync-muted').onclick = () => XMuteTimeline.sync().catch(error => setNotice(error.message));
    $('reply-form').onsubmit = async event => {
      event.preventDefault();
      if (await action('replies:add', {handle: $('reply-handle').value})) { $('reply-handle').value = ''; $('reply-handle').focus(); }
    };
    $('apply').onclick = async () => {
      // Include the last Shift-click even if its bag update is still in flight.
      await pickQueue;
      setPicking(false);
      await action('local:apply');
    };
    $('mute-on-x').onclick = async () => {
      await pickQueue;
      setPicking(false);
      await action('apply');
    };
    $('add-form').onsubmit = async e => {
      e.preventDefault();
      if (await action('add', {text: $('new-word').value})) { $('new-word').value = ''; $('new-word').focus(); }
    };
    for (const name of ['home', 'notifications', 'audience', 'duration']) {
      $(name).onchange = async () => {
        const options = {home: $('home').checked, notifications: $('notifications').checked, audience: $('audience').value, duration: $('duration').value};
        if (!await action('options', {options})) render();
      };
    }
  }
  function render() {
    if (!shadow || !visible) return;
    const $ = id => shadow.getElementById(id);
    const bag = state?.bag || [];
    const disabled = locked() || !state;
    renderTransfer();
    renderLocalWords();
    const filter = XMuteTimeline.status();
    $('filter-enabled').checked = filter.enabled;
    $('filter-enabled').disabled = !state;
    $('sync-muted').disabled = !state || !filter.enabled || filter.syncing || ['running', 'retrying'].includes(state.job?.status);
    $('filter-info').textContent = filter.error || (filter.syncing ? 'Syncing muted words from X…' :
      filter.enabled ? filter.words + ' filtered words' : 'Word filtering paused');
    $('filter-info').textContent += ' · ' + filter.hidden + ' posts hidden on this page';
    $('local-status').textContent = (state?.localWords?.length || 0) ? state.localWords.length + ' saved filters · ' + (filter.enabled ? filter.hidden + ' posts hidden' : 'filtering paused') : 'Filters posts on this device. No X mute limit.';
    $('reply-handle').disabled = !state; $('reply-add').disabled = !state;
    const replyRules = state?.replyRules || [];
    $('reply-count').textContent = replyRules.length ? '(' + replyRules.filter(rule => rule.enabled).length + ' active)' : '';
    const replySignature = JSON.stringify([replyRules, !!state]);
    if ($('reply-rules').dataset.signature !== replySignature) {
      const focused = shadow.activeElement?.dataset.rule;
      $('reply-rules').replaceChildren();
      for (const rule of replyRules) {
        const li = document.createElement('li'); li.className = 'rule';
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.checked = rule.enabled; input.dataset.rule = rule.handle;
        input.setAttribute('aria-label', 'Hide replies from @' + rule.handle);
        input.onchange = async () => {
          if (!await action('replies:toggle', {handle: rule.handle, enabled: input.checked})) input.checked = rule.enabled;
        };
        label.append(input, '@' + rule.handle);
        const remove = document.createElement('button'); remove.textContent = '×';
        remove.setAttribute('aria-label', 'Remove reply rule for @' + rule.handle);
        remove.onclick = () => action('replies:remove', {handle: rule.handle});
        li.append(label, remove); $('reply-rules').append(li);
      }
      $('reply-rules').dataset.signature = replySignature;
      if (focused) [...$('reply-rules').querySelectorAll('input')].find(input => input.dataset.rule === focused)?.focus();
    }
    const handles = [...new Set([...document.querySelectorAll('article[data-testid="tweet"]')].map(X.postAuthor).filter(Boolean))].sort();
    if ($('reply-suggestions').dataset.signature !== handles.join(',')) {
      $('reply-suggestions').replaceChildren(...handles.map(handle => {
        const option = document.createElement('option'); option.value = '@' + handle; return option;
      }));
      $('reply-suggestions').dataset.signature = handles.join(',');
    }
    $('identity').textContent = state ? '@' + state.account : 'Sign in to X to start';
    $('count').textContent = String(bag.length);
    $('count').hidden = !bag.length;
    $('body').hidden = collapsed;
    $('collapse').textContent = collapsed ? '+' : '−';
    $('collapse').setAttribute('aria-label', collapsed ? 'Expand bag' : 'Collapse bag');
    $('collapse').setAttribute('aria-expanded', String(!collapsed));
    $('pick').textContent = active ? 'Picking words · Esc to stop' : 'Start picking words';
    $('pick-hint').hidden = !active;
    $('pick').setAttribute('aria-pressed', String(active));
    $('pick').disabled = disabled;
    if (!bag.length) bagLimit = 100;
    const signature = JSON.stringify([bag, disabled, bagLimit]);
    if ($('entries').dataset.signature !== signature) {
      // Keep focus/caret when an unrelated state notification arrives.
      const focused = shadow.activeElement;
      const focusId = focused?.dataset.entry;
      const selection = focusId ? [focused.selectionStart, focused.selectionEnd] : null;
      $('entries').replaceChildren();
      for (const item of bag.slice(0, bagLimit)) {
        const li = document.createElement('li'); li.className = 'entry';
        const input = document.createElement('input');
        input.type = 'text'; input.value = item.text; input.dataset.entry = item.id;
        input.setAttribute('aria-label', 'Edit ' + item.text); input.disabled = disabled;
        input.onchange = async () => { if (!await action('edit', {id: item.id, text: input.value})) input.value = item.text; };
        input.onkeydown = e => { if (e.key === 'Enter') input.blur(); };
        const remove = document.createElement('button');
        remove.textContent = '×'; remove.disabled = disabled; remove.setAttribute('aria-label', 'Remove ' + item.text);
        remove.onclick = () => action('remove', {id: item.id});
        li.append(input, remove); $('entries').append(li);
      }
      $('entries').dataset.signature = signature;
      if (focusId) {
        const input = [...$('entries').querySelectorAll('input')].find(e => e.dataset.entry === focusId);
        input?.focus(); if (input && selection) input.setSelectionRange(...selection);
      }
    }
    $('empty').hidden = bag.length > 0;
    $('entries').hidden = !bag.length;
    $('more-entries').hidden = bag.length <= bagLimit;
    $('more-entries').textContent = 'Show ' + Math.min(100, bag.length - bagLimit) + ' more · ' + bag.length + ' total';
    $('bag-tools').hidden = !bag.length;
    $('clear').disabled = disabled || !bag.length;
    $('new-word').disabled = disabled; $('add').disabled = disabled;
    const prefs = state?.options || C.DEFAULTS;
    for (const name of ['home', 'notifications']) { $(name).checked = prefs[name]; $(name).disabled = disabled; }
    for (const name of ['audience', 'duration']) { $(name).value = prefs[name]; $(name).disabled = disabled || (name === 'audience' && !prefs.notifications); }
    const duration = {forever: 'Forever', '24h': '24 hours', '7d': '7 days', '30d': '30 days'}[prefs.duration];
    $('summary').textContent = 'Mute on X (optional) · ' + duration;
    $('mute-on-x').disabled = disabled || !bag.length;
    $('apply').disabled = !state || !bag.length;
    $('apply').textContent = 'Filter ' + (bag.length ? bag.length + ' ' + (bag.length === 1 ? 'word' : 'words') : 'words');
    const job = state?.job;
    $('status').hidden = !job || job.status === 'stopped' || (job.status === 'complete' && bag.length > 0);
    if (job) {
      const counts = C.counts(job), finished = counts.added + counts.skipped;
      $('status-text').textContent = job.status === 'running' ? 'Applying ' + Math.min(job.index + 1, counts.total) + ' of ' + counts.total :
        job.status === 'retrying' ? 'Retrying automatically' : job.status === 'paused' ? 'Stopped' : 'Done · ' + finished + ' processed';
      $('status-next').hidden = job.status !== 'retrying';
      $('status-next').textContent = job.status === 'retrying' ? 'Next attempt at ' + new Date(job.retryAt).toLocaleTimeString() : '';
      $('status-counts').textContent = counts.added + ' added · ' + counts.skipped + ' already muted' +
        (counts.failed ? ' · ' + counts.failed + ' unresolved' : '') + (job.retryCount ? ' · ' + job.retryCount + ' retries' : '');
      $('status-error').textContent = job.error || '';
      $('bar').style.width = (finished / counts.total * 100) + '%';
      $('batch-actions').replaceChildren();
      $('batch-extra-actions').replaceChildren();
      const commands = ['running', 'retrying'].includes(job.status) ? [['Stop', 'stop']] : job.status === 'paused' ? [['Resume / retry', 'resume']] : [];
      const extras = C.activeJob(job) ? [...(job.status === 'retrying' ? [['Retry now', 'resume']] : []), ['Settings tab', 'show-tab'], ['End batch', 'end']] : [];
      for (const [label, command] of [...commands, ...extras]) {
        const button = document.createElement('button'); button.textContent = label;
        button.onclick = () => action(command);
        $(['stop', 'resume'].includes(command) && label !== 'Retry now' ? 'batch-actions' : 'batch-extra-actions').append(button);
      }
    }
    setNotice(notice);
    updateTheme();
  }
  function updateTheme() {
    if (!host) return;
    const rgb = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)?.map(Number);
    host.toggleAttribute('data-light', !!rgb && rgb[0] + rgb[1] + rgb[2] > 500 && rgb[3] !== 0);
  }
  const highlights = () => CSS.highlights;
  function joinedRange(first, last) {
    if (first.start > last.start) [first, last] = [last, first];
    const range = document.createRange();
    range.setStart(first.range.startContainer, first.range.startOffset);
    range.setEnd(last.range.endContainer, last.range.endOffset);
    return range;
  }
  function phrase(first, last) {
    if (!first || first.element !== last.element || first.source !== last.source) return null;
    return {
      text: C.clean(first.source.slice(Math.min(first.start, last.start), Math.max(first.end, last.end))),
      range: joinedRange(first, last),
    };
  }
  function paintHover() {
    if (!highlights() || typeof Highlight === 'undefined') return;
    const range = hover && (shiftHeld && anchor ? phrase(anchor, hover)?.range : hover.range);
    highlights().set('xmb-hover', new Highlight(...(range ? [range] : [])));
  }
  function paint() {
    if (!highlights() || typeof Highlight === 'undefined') return;
    const selected = new Set(state?.bag.map(item => item.key));
    const picked = [];
    for (let start = 0; start < records.length; start++) {
      const first = records[start];
      const possible = [...selected].filter(key => key.startsWith(C.key(first.text)));
      if (!possible.length) continue;
      for (let end = start; end < records.length && records[end].element === first.element; end++) {
        const last = records[end];
        const key = C.key(first.source.slice(first.start, last.end));
        if (!possible.some(value => value.startsWith(key))) break;
        if (selected.has(key)) picked.push(joinedRange(first, last));
      }
    }
    highlights().set('xmb-picked', new Highlight(...picked));
    paintHover();
  }
  let highlightStyle;
  function setPicking(value) {
    active = !!value && !!state && !locked();
    anchor = null; shiftHeld = false; pickGeneration++;
    hover = null;
    if (active) {
      if (!highlightStyle) {
        highlightStyle = document.createElement('style');
        highlightStyle.textContent = '::highlight(xmb-picked){background:#7ddbb870;color:inherit}::highlight(xmb-hover){background:#b8f4da;color:#123b2b}html[data-xmb-picking] [data-testid="tweetText"]{cursor:crosshair!important}';
        document.documentElement.append(highlightStyle);
      }
      document.documentElement.dataset.xmbPicking = '';
      scheduleRanges();
    } else {
      delete document.documentElement.dataset.xmbPicking;
      records = [];
      highlights()?.delete('xmb-picked'); highlights()?.delete('xmb-hover');
    }
    if (visible) render();
  }
  function scheduleRanges() {
    if (!active || refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => { refreshFrame = 0; collectRanges(); });
  }
  function collectRanges() {
    records = [];
    if (!active) return;
    for (const element of document.querySelectorAll('[data-testid="tweetText"]')) {
      if (!element.closest('article[data-testid="tweet"]') || element.closest('[contenteditable="true"]')) continue;
      const box = element.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) continue;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) { return node.parentElement.closest('[aria-hidden="true"],script,style,[hidden]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
      });
      let node, text = ''; const nodes = [];
      while ((node = walker.nextNode())) {
        if (!node.parentElement.getClientRects().length) continue;
        nodes.push({node, start: text.length, end: text.length + node.length}); text += node.data;
      }
      for (const token of C.tokens(text, element.lang)) {
        const start = nodes.find(n => n.start <= token.start && n.end > token.start);
        const end = nodes.find(n => n.start < token.end && n.end >= token.end);
        if (!start || !end) continue;
        const range = document.createRange();
        range.setStart(start.node, token.start - start.start); range.setEnd(end.node, token.end - end.start);
        records.push({...token, range, element, source: text});
      }
    }
    if (anchor) {
      const updated = records.find(r => r.element === anchor.element && r.source === anchor.source && r.start === anchor.start && r.end === anchor.end);
      anchor = updated && anchor.url === location.href ? {...anchor, ...updated} : null;
    }
    hover = null; paint();
  }
  function hit(event) {
    if (!active || event.composedPath().includes(host)) return null;
    const tweet = event.target.closest?.('[data-testid="tweetText"]');
    if (!tweet) return null;
    const inside = r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
    return records.find(r => r.element === tweet && r.range.startContainer.isConnected && [...r.range.getClientRects()].some(inside)) || null;
  }
  function onPointer(event) {
    const found = hit(event);
    if (found !== hover || shiftHeld !== event.shiftKey) {
      hover = found; shiftHeld = event.shiftKey; paintHover();
    }
  }
  async function pickWord(found, extend, generation) {
    if (!active || generation !== pickGeneration || locked()) return;
    // Re-resolve ranges after async bag writes or X recycling its tweet elements.
    collectRanges();
    found = records.find(r => r.element === found.element && r.source === found.source && r.start === found.start && r.end === found.end);
    if (!found) return;
    const previous = extend ? anchor : null;
    const selection = previous ? phrase(previous, found) : {text: found.text};
    if (!selection) {
      setNotice('Shift-click within the same post. Click a word to start a new phrase.');
      return;
    }
    const repeated = !extend && anchor?.element === found.element && anchor.source === found.source &&
      anchor.start === found.start && anchor.end === found.end && anchor.owned?.key === C.key(found.text);
    const next = await action('pick', {text: selection.text, replace: previous?.owned || (repeated ? anchor.owned : undefined)});
    if (next && active && generation === pickGeneration) {
      anchor = {...(previous || found), url: location.href, owned: next.selection.owned ? next.selection : null};
      scheduleRanges();
    }
  }
  function onPick(event) {
    const found = hit(event);
    if (!found || event.button !== 0) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === 'click') {
      const extend = event.shiftKey, generation = pickGeneration;
      pickQueue = pickQueue.then(() => pickWord(found, extend, generation)).catch(error => setNotice(error.message));
    }
  }
  document.addEventListener('pointermove', onPointer, true);
  for (const name of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) document.addEventListener(name, onPick, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Shift' && active) { shiftHeld = true; paintHover(); }
    if (event.key === 'Escape' && active) {
      event.preventDefault(); event.stopImmediatePropagation(); setPicking(false);
    }
  }, true);
  document.addEventListener('keyup', event => {
    if (event.key === 'Shift') { shiftHeld = false; paintHover(); }
  }, true);
  window.addEventListener('blur', () => { shiftHeld = false; hover = null; paintHover(); });
  document.addEventListener('scroll', scheduleRanges, {capture: true, passive: true});
  window.addEventListener('resize', scheduleRanges, {passive: true});
  new MutationObserver(mutations => {
    if (!mutations.some(m => m.target !== host && !host?.contains(m.target) && m.target !== highlightStyle)) return;
    scheduleRanges();
    if (visible) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (state?.account !== X.account()) refresh().catch(error => setNotice(error.message));
        else updateTheme();
      }, 200);
    }
  }).observe(document.documentElement, {childList: true, subtree: true, characterData: true});

  async function waitFor(probe, job, label, timeout = 20000) {
    const deadline = Date.now() + timeout;
    const inspect = () => {
      if (job) {
        if (cancelledJob === job.id) throw new Error('The batch was stopped.');
        const actual = X.account();
        if (actual && actual !== job.account) throw new Error('Waiting for @' + job.account + '. Switch back; retries will continue automatically.');
        if (/^\/i\/flow\/login|^\/login/.test(location.pathname)) throw new Error('Sign in to @' + job.account + ' on X. Retrying automatically.');
      }
      const result = probe();
      if (result) return result;
      if (Date.now() >= deadline) throw new Error('Timed out ' + label + '. Retrying automatically.');
      return null;
    };
    const ready = inspect();
    if (ready) return ready;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        settled = true;
        observer.disconnect(); clearInterval(timer); runnerWaiters.delete(check);
        for (const event of ['input', 'change']) document.removeEventListener(event, check, true);
        window.removeEventListener('popstate', check);
        if (error) reject(error); else resolve(value);
      };
      const check = () => {
        if (settled) return;
        try { const result = inspect(); if (result) finish(null, result); }
        catch (error) { finish(error); }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true});
      for (const event of ['input', 'change']) document.addEventListener(event, check, true);
      window.addEventListener('popstate', check);
      runnerWaiters.add(check);
      // Only a backstop for deadlines and property changes without DOM events.
      // Successful progress wakes on changes, even when background timers are throttled.
      const timer = setInterval(check, 1000);
      check();
    });
  }
  async function runBatch() {
    if (runnerBusy) { runnerQueued = true; return; }
    runnerBusy = true;
    let job, importedSnapshot = '';
    try {
      job = await request('runner:discover');
      if (!job) return;
      cancelledJob = null;
      while (job?.status === 'running') {
        await waitFor(() => X.account() === job.account, job, 'waiting for your X account');
        if (![X.ADD, X.LIST].includes(location.pathname)) throw new Error('The settings tab left muted words. Retrying automatically.');
        const item = job.items[job.index];
        const send = (type, extra = {}) => request(type, {account: job.account, jobId: job.id, runId: job.runId, itemId: item.id, ...extra});
        const expectedPath = job.phase === 'form' ? X.ADD : X.LIST;
        if (location.pathname !== expectedPath) {
          if (expectedPath === X.ADD && X.openAddForm()) {
            await waitFor(() => X.form(), job, 'opening the muted-word form');
          } else {
            location.assign('https://x.com' + expectedPath);
            return;
          }
        }
        if (job.phase === 'check' || job.phase === 'verify') {
          const snapshot = await waitFor(() => X.mutedSnapshot(), job, 'reading muted words');
          const words = new Set(snapshot.map(word => word.key));
          const signature = JSON.stringify(snapshot);
          if (signature !== importedSnapshot) {
            await request('filters:import', {account: job.account, words: snapshot});
            importedSnapshot = signature;
          }
          if (words.has(item.key)) job = await send('runner:found');
          else if (job.phase === 'check') job = await send('runner:missing');
          else {
            await waitFor(() => X.list()?.has(item.key), job, 'confirming the saved word');
            job = await send('runner:found');
          }
        } else if (job.phase === 'form') {
          await waitFor(() => X.form(), job, 'loading X’s English muted-word form');
          X.setKeyword(X.form().keyword, item.text);
          X.setOptions(job.options);
          await waitFor(() => {
            const error = X.error(); if (error) throw new Error(error);
            return X.ready(item.text, job.options);
          }, job, 'preparing the muted word');
          await send('runner:submit');
          if (cancelledJob === job.id) throw new Error('The batch was stopped.');
          if (X.account() !== job.account) throw new Error('Waiting for @' + job.account + '. Switch back; retries will continue automatically.');
          if (!X.ready(item.text, job.options)) throw new Error('The form changed before saving. Retry to check progress.');
          X.form().save.click();
          await waitFor(() => {
            const error = X.error(); if (error) throw new Error(error);
            return location.pathname === X.LIST;
          }, job, 'waiting for X to save the word');
          job = await request('runner:discover');
        }
      }
    } catch (error) {
      if (job) {
        await request('runner:failed', {account: job.account, jobId: job.id, runId: job.runId, itemId: job.items[job.index]?.id,
          error: error.message}).catch(() => {});
      }
    } finally {
      runnerBusy = false;
      if (runnerQueued) { runnerQueued = false; runBatch(); }
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'TOGGLE') {
      (async () => {
        createPanel();
        if (visible && active) { setPicking(false); visible = false; host.hidden = true; }
        else {
          visible = true; host.hidden = false; collapsed = false;
          await refresh(); setPicking(!locked());
        }
      })().catch(error => setNotice(error.message));
      respond({ok: true});
    }
    if (message.type === 'RUN') { for (const check of runnerWaiters) check(); runBatch(); respond({ok: true}); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.xMuteBag) return;
    const next = changes.xMuteBag.newValue?.job;
    if (next && next.status !== 'running') cancelledJob = next.id;
    for (const check of runnerWaiters) check();
    if (visible) refresh().catch(error => setNotice(error.message));
  });
  XMuteTimeline.subscribe(() => { if (visible) render(); });
  runBatch();
})();
