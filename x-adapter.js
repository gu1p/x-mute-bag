/* All assumptions about X’s page structure live here. Fail closed when it changes. */
(() => {
  'use strict';
  const C = XMuteCore;
  const LIST = '/settings/muted_keywords';
  const ADD = '/settings/add_muted_keyword';
  const account = () => {
    const href = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
    const match = href?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/);
    return match ? match[1].toLowerCase() : null;
  };
  function details() {
    const heading = [...document.querySelectorAll('main h2')].find(e => ['Muted words', 'Add muted word'].includes(e.textContent.trim()));
    return heading?.closest('[role="region"]') || null;
  }
  function list() {
    const snapshot = mutedSnapshot();
    return snapshot ? new Set(snapshot.map(word => word.key)) : null;
  }
  function mutedSnapshot() {
    if (location.pathname !== LIST) return null;
    const region = details();
    if (!region || !region.querySelector('a[href="/settings/add_muted_keyword"]') ||
        region.querySelector('[role="progressbar"]')) return null;
    if ([...region.querySelectorAll('[role="alert"],[data-testid="error-detail"]')].some(node => node.textContent.trim()) ||
        [...region.querySelectorAll('button')].some(button => /^(Retry|Reload|Try again)$/.test(button.textContent.trim()))) return null;
    const words = [];
    for (const button of region.querySelectorAll('button[aria-label="Unmute"]')) {
      const row = button.closest('[role="link"]');
      const word = row?.firstElementChild?.firstElementChild?.textContent;
      if (!word?.trim()) throw new Error('X’s muted-word list has changed. Open the settings tab to review it.');
      words.push({text: C.clean(word), key: C.key(word), forever: row.firstElementChild.children[1]?.textContent.trim() === 'Forever'});
    }
    return words;
  }
  function form() {
    if (location.pathname !== ADD) return null;
    const keyword = document.querySelector('input[name="keyword"]');
    const region = keyword?.closest('[role="region"]');
    if (!region) return null;
    const labeled = (selector, label) => [...region.querySelectorAll(selector)].find(e => {
      return e.closest('label')?.textContent.trim() === label;
    });
    const result = {
      keyword,
      home: labeled('input[type="checkbox"]:not([role="switch"])', 'Home timeline'),
      notifications: labeled('input[role="switch"]', 'Notifications'),
      save: region.querySelector('[data-testid="settingsDetailSave"]'),
      audience: {},
      duration: {},
    };
    for (const [value, label] of Object.entries({anyone: 'From anyone', unfollowed: 'From people you don’t follow'})) {
      result.audience[value] = labeled('input[name="mute_notifications_option"]', label);
    }
    for (const [value, label] of Object.entries({forever: 'Until you unmute the word', '24h': '24 hours', '7d': '7 days', '30d': '30 days'})) {
      result.duration[value] = labeled('input[name="time_duration"]', label);
    }
    if (!result.home || !result.notifications || !result.save || Object.values(result.duration).some(e => !e)) return null;
    return result;
  }
  function setKeyword(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function checked(input, value) {
    if (!input) throw new Error('X’s mute options have changed.');
    if (input.checked !== value) input.click();
  }
  function setOptions(prefs) {
    let controls = form();
    if (!controls) throw new Error('Could not recognize X’s English muted-word form.');
    checked(controls.home, prefs.home);
    checked(controls.notifications, prefs.notifications);
    // Turning notifications on can mount a new radio group.
    controls = form();
    if (prefs.notifications) checked(controls.audience[prefs.audience], true);
    checked(controls.duration[prefs.duration], true);
  }
  function ready(text, prefs) {
    const f = form();
    return f && f.keyword.value === text && f.home.checked === prefs.home &&
      f.notifications.checked === prefs.notifications && f.duration[prefs.duration]?.checked &&
      (!prefs.notifications || f.audience[prefs.audience]?.checked) &&
      !f.save.disabled && f.save.getAttribute('aria-disabled') !== 'true';
  }
  function error() {
    const region = details();
    const candidates = [...(region?.querySelectorAll('[role="alert"], [data-testid="error-detail"], [aria-live="assertive"]') || [])];
    const invalid = region?.querySelector('input[aria-invalid="true"]');
    if (invalid) {
      const id = invalid.getAttribute('aria-describedby');
      return (id && document.getElementById(id)?.textContent) || 'X rejected this entry. Review it in the settings tab.';
    }
    const toast = document.querySelector('[data-testid="toast"]');
    if (toast && /error|try again|limit|already|unable|failed|too long/i.test(toast.textContent)) candidates.push(toast);
    return candidates.map(e => e.textContent.trim()).find(Boolean) || null;
  }
  function postTexts(article) {
    return [...article.querySelectorAll('[data-testid="tweetText"]')].map(block => {
      const read = node => {
        if (node.nodeType === Node.TEXT_NODE) return node.data;
        if (node.nodeType !== Node.ELEMENT_NODE || node.matches('[aria-hidden="true"],script,style,[hidden]')) return '';
        if (node.tagName === 'BR') return '\n';
        if (node.tagName === 'IMG') return node.getAttribute('alt') || '';
        return [...node.childNodes].map(read).join('');
      };
      return read(block);
    });
  }
  globalThis.XMuteX = {LIST, ADD, account, list, mutedSnapshot, postTexts, form, setKeyword, setOptions, ready, error};
})();
