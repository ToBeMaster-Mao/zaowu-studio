const enhancedSelects = new WeakMap();
let closeActiveMenu = null;
let nextSelectId = 0;

const chevronIcon = '<svg class="studio-select-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
const checkIcon = '<svg class="studio-select-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg>';

/** Keep the native select as the form/data source while replacing its popup. */
export function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement)) throw new TypeError('enhanceSelect expects a select element.');
  if (enhancedSelects.has(select)) return enhancedSelects.get(select);

  const id = select.id || `studioSelect${++nextSelectId}`;
  const originalTabIndex = select.getAttribute('tabindex');
  const originalAriaHidden = select.getAttribute('aria-hidden');
  const button = document.createElement('button');
  button.type = 'button';
  button.id = `${id}Trigger`;
  button.className = 'studio-select-trigger';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', `${id}Menu`);
  const text = document.createElement('span');
  text.className = 'studio-select-value';
  button.append(text);
  button.insertAdjacentHTML('beforeend', chevronIcon);
  select.insertAdjacentElement('afterend', button);
  select.classList.add('studio-select-source');
  select.setAttribute('tabindex', '-1');
  select.setAttribute('aria-hidden', 'true');

  const menu = document.createElement('div');
  menu.id = `${id}Menu`;
  menu.className = 'studio-select-menu';
  menu.dataset.selectId = id;
  menu.setAttribute('role', 'listbox');
  menu.tabIndex = -1;
  menu.hidden = true;
  document.body.append(menu);

  let entries = [];
  let activeIndex = -1;
  let isOpen = false;
  let destroyed = false;
  let positionFrame = 0;
  let searchText = '';
  let searchTime = 0;
  const eventController = new AbortController();
  const listen = (target, type, listener, options = {}) => target.addEventListener(type, listener, { ...options, signal: eventController.signal });
  const enabled = () => entries.filter(entry => !entry.disabled);
  const accessibleName = () => select.getAttribute('aria-label') || select.labels?.[0]?.textContent.trim() || '选择';

  function keepActiveVisible() {
    const row = entries.find(entry => entry.index === activeIndex)?.node;
    if (!row) return;
    const menuRect = menu.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < menuRect.top + 6) menu.scrollTop -= menuRect.top + 6 - rowRect.top;
    else if (rowRect.bottom > menuRect.bottom - 6) menu.scrollTop += rowRect.bottom - menuRect.bottom + 6;
  }

  function setActive(index, scroll = true) {
    activeIndex = index;
    for (const entry of entries) entry.node.classList.toggle('is-active', entry.index === index);
    const active = entries.find(entry => entry.index === index);
    if (active) menu.setAttribute('aria-activedescendant', active.node.id);
    else menu.removeAttribute('aria-activedescendant');
    if (scroll) keepActiveVisible();
  }

  function positionMenu() {
    if (!isOpen) return;
    const anchor = button.getBoundingClientRect();
    if (!anchor.width || !anchor.height) {
      close();
      return;
    }
    const margin = 12;
    const gap = 7;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const minWidth = id === 'cameraViewSelect' ? 160 : 208;
    const width = Math.min(Math.max(anchor.width, minWidth), Math.max(0, viewportWidth - margin * 2));
    const below = Math.max(0, viewportHeight - anchor.bottom - gap - margin);
    const above = Math.max(0, anchor.top - gap - margin);
    const preferredHeight = Math.min(320, menu.scrollHeight || entries.length * 36 + 12);
    const openAbove = below < Math.min(preferredHeight, 180) && above > below;
    menu.dataset.placement = openAbove ? 'top' : 'bottom';
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${Math.min(320, openAbove ? above : below)}px`;
    menu.style.left = `${Math.max(margin, Math.min(anchor.left, viewportWidth - width - margin))}px`;
    menu.style.top = `${openAbove ? Math.max(margin, anchor.top - gap - menu.offsetHeight) : anchor.bottom + gap}px`;
  }

  function schedulePosition() {
    if (!isOpen || positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      positionMenu();
    });
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (closeActiveMenu === close) closeActiveMenu = null;
    if (positionFrame) cancelAnimationFrame(positionFrame);
    positionFrame = 0;
    searchText = '';
    if (restoreFocus && !button.disabled) button.focus({ preventScroll: true });
  }

  function refresh() {
    if (destroyed) return;
    const selected = select.options[select.selectedIndex];
    text.textContent = selected?.label || '';
    button.title = selected?.label || '';
    button.disabled = select.disabled;
    button.setAttribute('aria-label', `${accessibleName()}${selected?.label ? `：${selected.label}` : ''}`);
    menu.setAttribute('aria-label', accessibleName());
    if (select.disabled) close();

    entries = [...select.options].flatMap((option, index) => {
      const group = option.parentElement;
      if (option.hidden || (group?.tagName === 'OPTGROUP' && group.hidden)) return [];
      const disabled = option.disabled || (group?.tagName === 'OPTGROUP' && group.disabled);
      const node = document.createElement('div');
      node.id = `${id}Option${index}`;
      node.className = 'studio-select-option';
      node.dataset.optionIndex = String(index);
      node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', String(index === select.selectedIndex));
      if (disabled) node.setAttribute('aria-disabled', 'true');
      const label = document.createElement('span');
      label.className = 'studio-select-option-label';
      label.textContent = option.label;
      node.title = option.label;
      node.append(label);
      node.insertAdjacentHTML('beforeend', checkIcon);
      return [{ node, index, disabled, label: option.label }];
    });
    menu.replaceChildren(...entries.map(entry => entry.node));
    if (!entries.length) close();
    const activeStillEnabled = entries.some(entry => entry.index === activeIndex && !entry.disabled);
    if (!activeStillEnabled || !isOpen) {
      activeIndex = entries.find(entry => entry.index === select.selectedIndex && !entry.disabled)?.index ?? enabled()[0]?.index ?? -1;
    }
    setActive(activeIndex, false);
    if (isOpen) {
      positionMenu();
      keepActiveVisible();
    }
  }

  function open() {
    refresh();
    if (button.disabled || !entries.length) return;
    if (isOpen) return;
    closeActiveMenu?.();
    closeActiveMenu = close;
    isOpen = true;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    positionMenu();
    menu.focus({ preventScroll: true });
    keepActiveVisible();
  }

  function moveActive(delta) {
    const available = enabled();
    if (!available.length) return;
    const index = available.findIndex(entry => entry.index === activeIndex);
    setActive(available[Math.max(0, Math.min(available.length - 1, index + delta))].index);
  }

  function choose(index) {
    const entry = entries.find(item => item.index === index);
    if (!entry || entry.disabled || select.disabled) return;
    const changed = select.selectedIndex !== index;
    close({ restoreFocus: true });
    select.selectedIndex = index;
    refresh();
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function onKeyDown(event) {
    if (button.disabled || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') {
      if (isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true });
      }
      return;
    }
    if (event.key === 'Tab') {
      // Let the browser continue from the trigger's position in the tab order.
      close({ restoreFocus: true });
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!isOpen) open();
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') moveActive(event.key === 'ArrowDown' ? 1 : -1);
      if (event.key === 'Home') setActive(enabled()[0]?.index ?? -1);
      if (event.key === 'End') setActive(enabled().at(-1)?.index ?? -1);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (isOpen) choose(activeIndex);
      else open();
      return;
    }
    if (event.key.length === 1 && !event.altKey) {
      event.preventDefault();
      if (!isOpen) open();
      const now = performance.now();
      searchText = now - searchTime < 650 ? searchText + event.key : event.key;
      searchTime = now;
      const needle = [...searchText].every(letter => letter === searchText[0]) ? searchText[0] : searchText;
      const available = enabled();
      const current = available.findIndex(entry => entry.index === activeIndex);
      const ordered = [...available.slice(current + 1), ...available.slice(0, current + 1)];
      const match = ordered.find(entry => entry.label.toLocaleLowerCase().startsWith(needle.toLocaleLowerCase()));
      if (match) setActive(match.index);
    }
  }

  listen(button, 'click', () => { if (isOpen) close(); else open(); });
  listen(button, 'keydown', onKeyDown);
  listen(menu, 'keydown', onKeyDown);
  listen(menu, 'pointermove', event => {
    const row = event.target.closest('[data-option-index]');
    if (row?.getAttribute('aria-disabled') !== 'true' && row) setActive(Number(row.dataset.optionIndex), false);
  });
  listen(menu, 'click', event => {
    const row = event.target.closest('[data-option-index]');
    if (row) choose(Number(row.dataset.optionIndex));
  });
  listen(document, 'pointerdown', event => {
    if (isOpen && !button.contains(event.target) && !menu.contains(event.target)) close();
  }, { capture: true });
  listen(document, 'focusin', event => {
    if (isOpen && !button.contains(event.target) && !menu.contains(event.target)) close();
  });
  listen(document, 'scroll', event => {
    if (!menu.contains(event.target)) schedulePosition();
  }, { capture: true, passive: true });
  listen(window, 'resize', schedulePosition, { passive: true });
  listen(window, 'blur', () => close());
  listen(select, 'change', refresh);
  if (select.form) listen(select.form, 'reset', () => queueMicrotask(refresh));
  const observer = new MutationObserver(refresh);
  observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'label', 'selected', 'value', 'aria-label'] });
  const anchorObserver = new ResizeObserver(schedulePosition);
  anchorObserver.observe(button);

  const controller = {
    refresh,
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      observer.disconnect();
      anchorObserver.disconnect();
      eventController.abort();
      button.remove();
      menu.remove();
      select.classList.remove('studio-select-source');
      if (originalTabIndex === null) select.removeAttribute('tabindex');
      else select.setAttribute('tabindex', originalTabIndex);
      if (originalAriaHidden === null) select.removeAttribute('aria-hidden');
      else select.setAttribute('aria-hidden', originalAriaHidden);
      enhancedSelects.delete(select);
    },
  };
  enhancedSelects.set(select, controller);
  refresh();
  return controller;
}
