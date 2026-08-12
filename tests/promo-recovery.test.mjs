
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'js/ngr-stock.js'), 'utf8');
const begin = source.indexOf('  /* NGR_PROMO_RECOVERY_BEGIN */');
const end = source.indexOf('  /* NGR_PROMO_RECOVERY_END */', begin);
assert.ok(begin > -1 && end > begin, 'promo recovery block must be marked and extractable');
const promoSource = source.slice(begin, end);

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.values = new Set();
  }
  set(value) {
    this.values = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toString() { return [...this.values].join(' '); }
}

class FakeStyle {
  setProperty(name, value) { this[name] = value; }
  removeProperty(name) { const old = this[name] || ''; delete this[name]; return old; }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.style = new FakeStyle();
    this.listeners = new Map();
    this._text = '';
    this._connected = true;
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.focused = false;
    this.selected = false;
    this.id = '';
  }
  set className(value) { this.classList.set(value); }
  get className() { return this.classList.toString(); }
  set textContent(value) {
    this._text = String(value ?? '');
    this.children.forEach((child) => { child.parentNode = null; });
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }
  get firstChild() { return this.children[0] || null; }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node._connected !== false;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index > -1) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }
  getAttribute(name) {
    if (name === 'id') return this.id || null;
    if (name === 'class') return this.className || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) { return name === 'id' ? Boolean(this.id) : this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'id') this.id = '';
  }
  matches(selector) {
    if (selector.startsWith('.')) {
      return selector.split('.').filter(Boolean).every((name) => this.classList.contains(name));
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (child.matches(selector)) found.push(child);
        visit(child);
      });
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  fire(type, target = this, extra = {}) {
    const event = {
      target,
      key: extra.key,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    (this.listeners.get(type) || []).forEach((listener) => listener(event));
    return event;
  }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  click() {
    let node = this.parentNode;
    while (node && !(node.listeners.get('click') || []).length) node = node.parentNode;
    if (node) node.fire('click', this);
  }
}

class FakeMutationObserver {
  static all = [];
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    FakeMutationObserver.all.push(this);
  }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() { this.disconnected = true; }
  trigger() { if (!this.disconnected) this.callback([{ target: this.target }]); }
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement('head');
    this.groups = [];
  }
  createElement(tagName) { return new FakeElement(tagName); }
  querySelectorAll(selector) {
    return selector.includes('t-input-group_pc') ? this.groups.slice() : [];
  }
  getElementById(id) {
    const roots = [this.head, ...this.groups];
    for (const root of roots) {
      if (root.id === id) return root;
      const stack = [...root.children];
      while (stack.length) {
        const node = stack.shift();
        if (node.id === id) return node;
        stack.push(...node.children);
      }
    }
    return null;
  }
}

function createHarness() {
  FakeMutationObserver.all = [];
  const document = new FakeDocument();
  const timers = [];
  const storageCalls = [];
  const window = {
    tcart: { products: [{ sku: '1', quantity: 1 }], amount: 1000, prodamount: 1000 },
    cartCalculator: undefined,
    localStorage: {
      getItem(...args) { storageCalls.push(['getItem', ...args]); return null; },
      setItem(...args) { storageCalls.push(['setItem', ...args]); },
      removeItem(...args) { storageCalls.push(['removeItem', ...args]); },
    },
  };
  const initCalls = [];
  window.t_input_promocode_init = (...args) => { initCalls.push(args); };
  const context = vm.createContext({
    window,
    document,
    MutationObserver: FakeMutationObserver,
    WeakMap,
    WeakSet,
    Number,
    String,
    console,
    setTimeout(callback) { timers.push(callback); return timers.length; },
  });
  vm.runInContext(promoSource, context);

  const record = new FakeElement('div');
  record.id = 'rec2503594821';
  const group = new FakeElement('div');
  group.className = 't-input-group t-input-group_pc';
  group.setAttribute('data-field-type', 'pc');
  group.setAttribute('data-input-lid', '202607300001');
  const panel = new FakeElement('div');
  panel.className = 'ngr-promo-panel';
  panel.hidden = false;
  const title = new FakeElement('div');
  title.className = 't-input-title t-descr t-descr_md';
  title.id = 'field-title_202607300001';
  const block = new FakeElement('div');
  block.className = 't-input-block';
  const wrapper = new FakeElement('div');
  wrapper.className = 't-inputpromocode__wrapper';
  const input = new FakeElement('input');
  input.className = 't-input t-inputpromocode js-tilda-rule';
  input.setAttribute('data-tilda-rule', 'promocode');
  const apply = new FakeElement('div');
  apply.className = 't-inputpromocode__btn t-btn t-btn_md';
  apply.textContent = 'Применить';
  wrapper.appendChild(input);
  wrapper.appendChild(apply);
  block.appendChild(wrapper);
  panel.appendChild(title);
  panel.appendChild(block);
  group.appendChild(panel);
  record.appendChild(group);
  document.groups = [group];

  const runNextTimer = () => {
    const callback = timers.shift();
    if (callback) callback();
  };
  const runAllTimers = (limit = 50) => {
    let count = 0;
    while (timers.length && count < limit) { runNextTimer(); count += 1; }
    assert.ok(count < limit, 'fake timer queue should settle');
  };
  return {
    context,
    window,
    document,
    record,
    group,
    wrapper,
    input,
    apply,
    initCalls,
    storageCalls,
    timers,
    runNextTimer,
    runAllTimers,
  };
}

function cartSnapshot(harness) {
  return JSON.parse(JSON.stringify({
    tcart: harness.window.tcart,
    cartCalculator: harness.window.cartCalculator || null,
  }));
}

test('native rejection keeps an editable field, announces the error and clears without cart writes', () => {
  const h = createHarness();
  const before = cartSnapshot(h);
  h.context.fixPromocode();
  h.input.value = 'EXPIRED';
  h.window.t_promocode_load = 'y';
  h.group.fire('click', h.apply);
  delete h.window.t_promocode_load;
  h.runNextTimer();

  const error = h.group.querySelector('.ngr-promo-error');
  const clear = h.group.querySelector('.ngr-promo-clear');
  assert.equal(h.group.querySelector('.t-inputpromocode'), h.input);
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /не применён/i);
  assert.equal(h.input.getAttribute('aria-invalid'), 'true');
  assert.equal(clear.tagName, 'BUTTON');
  assert.equal(clear.disabled, false);

  h.group.fire('click', clear);
  assert.equal(h.input.value, '');
  assert.equal(h.input.focused, true);
  assert.equal(error.hidden, true);
  assert.equal(h.input.hasAttribute('aria-invalid'), false);
  assert.deepEqual(cartSnapshot(h), before);
  assert.deepEqual(h.storageCalls, []);
});
test('OK with zero discount restores one native input and initializes it exactly once', () => {
  const h = createHarness();
  const before = cartSnapshot(h);
  h.context.fixPromocode();
  h.input.value = 'ZERO';
  h.window.t_promocode_load = 'y';
  h.group.fire('click', h.apply);
  delete h.window.t_promocode_load;

  h.wrapper.textContent = '';
  const nativeSuccess = new FakeElement('div');
  nativeSuccess.className = 't-text';
  nativeSuccess.textContent = 'Промокод ZERO активирован.';
  h.wrapper.appendChild(nativeSuccess);
  FakeMutationObserver.all.at(-1).trigger();
  h.runAllTimers();

  const restored = h.group.querySelector('.t-inputpromocode');
  assert.ok(restored, 'the missing native input must be rebuilt');
  assert.equal(restored.value, 'ZERO');
  assert.equal(restored.getAttribute('data-ngr-promo-restored'), '1');
  assert.equal(h.group.querySelectorAll('.t-inputpromocode').length, 1);
  assert.equal(h.group.querySelectorAll('.ngr-promo-clear').length, 1);
  assert.deepEqual(h.initCalls, [['2503594821', '202607300001']]);
  assert.match(h.group.querySelector('.ngr-promo-error').textContent, /не даёт скидку/i);
  assert.equal(restored.focused, true);
  assert.equal(restored.selected, true);

  h.context.fixPromocode();
  FakeMutationObserver.all.at(-1).trigger();
  assert.equal(h.initCalls.length, 1, 'repeated apply/observer passes must not duplicate native listeners');
  assert.deepEqual(cartSnapshot(h), before);
  assert.deepEqual(h.storageCalls, []);
});

test('a successful cart promo is never replaced with another editor', () => {
  const h = createHarness();
  h.window.tcart.promocode = { promocode: 'SAVE10', discountpercent: '10' };
  const before = cartSnapshot(h);
  h.context.fixPromocode();

  assert.equal(h.group.querySelector('.t-inputpromocode'), null);
  assert.equal(h.group.querySelector('.ngr-promo-clear'), null);
  assert.match(h.wrapper.textContent, /SAVE10/);
  assert.equal(h.initCalls.length, 0);
  assert.deepEqual(cartSnapshot(h), before);
  assert.deepEqual(h.storageCalls, []);
});

test('a promo held only by the new calculator also blocks recovery', () => {
  const h = createHarness();
  h.window.cartCalculator = {
    appliedPromocode: { promocode: 'HELD15', discountsum: 150 },
    usedDiscounts: [],
  };
  const before = cartSnapshot(h);
  h.context.fixPromocode();

  assert.equal(h.group.querySelector('.t-inputpromocode'), null);
  assert.match(h.wrapper.textContent, /HELD15/);
  assert.equal(h.initCalls.length, 0);
  assert.deepEqual(cartSnapshot(h), before);
  assert.deepEqual(h.storageCalls, []);
});

// Инцидент 12.08: скидка 50% была в итогах корзины, но поле промокода краснело
// «не даёт скидку», а Tilda блокировала оформление «активируйте промокод» —
// детектор не признавал строковые проценты и объекты без полей скидки.
test('a percent-string discount ("50%") counts as an applied promo', () => {
  const h = createHarness();
  h.window.tcart.promocode = { promocode: 'TEST2026', discountpercent: '50%' };
  const before = cartSnapshot(h);
  h.context.fixPromocode();

  assert.equal(h.group.querySelector('.t-inputpromocode'), null,
    'the editor must not replace an applied promo');
  assert.match(h.wrapper.textContent, /TEST2026/);
  assert.equal(h.initCalls.length, 0);
  assert.deepEqual(cartSnapshot(h), before);
});

test('a cart promo without discount fields is trusted as applied', () => {
  const h = createHarness();
  h.window.tcart.promocode = { promocode: 'BARE' };
  h.context.fixPromocode();

  assert.equal(h.group.querySelector('.t-inputpromocode'), null);
  assert.match(h.wrapper.textContent, /BARE/);
});

// Повтор инцидента 12.08: Tilda этой версии может хранить применённый код
// строкой, а сумму скидки — на верхнем уровне корзины, не внутри объекта.
test('a string-shaped cart promo counts as applied', () => {
  const h = createHarness();
  h.window.tcart.promocode = 'test2026';
  h.context.fixPromocode();

  assert.equal(h.group.querySelector('.t-inputpromocode'), null,
    'the editor must not appear when Tilda stores the promo as a plain string');
  assert.match(h.wrapper.textContent, /test2026/);
});

test('zero promo fields with a top-level cart discount still mean applied', () => {
  const h = createHarness();
  h.window.tcart.promocode = { promocode: 'TEST2026', discountsum: 0 };
  h.window.tcart.prodamount_discountsum = '2 336';
  h.context.fixPromocode();

  assert.equal(h.group.querySelector('.t-inputpromocode'), null);
  assert.match(h.wrapper.textContent, /TEST2026/);
});

test('zero promo fields with a shrunken cart amount still mean applied', () => {
  const h = createHarness();
  h.window.tcart.promocode = { promocode: 'TEST2026', discountsum: '0' };
  h.window.tcart.prodamount = 4672;
  h.window.tcart.amount = 2336;
  h.context.fixPromocode();

  assert.equal(h.group.querySelector('.t-inputpromocode'), null);
  assert.match(h.wrapper.textContent, /TEST2026/);
});

test('zero-valued promo objects do not masquerade as successful discounts', () => {
  const h = createHarness();
  h.window.tcart.promocode = { promocode: 'ZERO', discountsum: '0', discountpercent: 0 };
  h.window.cartCalculator = { appliedPromocode: { promocode: 'ZERO2', discountsum: 0 } };
  h.context.fixPromocode();
  h.input.value = 'ZERO';
  h.window.t_promocode_load = 'y';
  h.group.fire('click', h.apply);
  delete h.window.t_promocode_load;
  h.wrapper.textContent = '';
  const nativeSuccess = new FakeElement('div');
  nativeSuccess.className = 't-text';
  h.wrapper.appendChild(nativeSuccess);
  h.context.settlePromo(h.group, h.context.promoStateFor(h.group).seq);

  assert.ok(h.group.querySelector('.t-inputpromocode'));
  assert.equal(h.initCalls.length, 1);
});

test('an in-flight request disables Clear and a detached cart ignores late settlement', () => {
  const h = createHarness();
  const before = cartSnapshot(h);
  h.context.fixPromocode();
  h.input.value = 'SLOW';
  h.window.t_promocode_load = 'y';
  h.group.fire('click', h.apply);

  const clear = h.group.querySelector('.ngr-promo-clear');
  const error = h.group.querySelector('.ngr-promo-error');
  assert.equal(clear.disabled, true);
  assert.equal(error.hidden, true);
  assert.equal(h.group.getAttribute('aria-busy'), 'true');

  h.record._connected = false;
  delete h.window.t_promocode_load;
  h.runNextTimer();
  assert.equal(error.hidden, true);
  assert.equal(h.group.querySelector('.t-inputpromocode'), h.input);
  assert.deepEqual(cartSnapshot(h), before);
  assert.deepEqual(h.storageCalls, []);
});

test('the component has responsive controls and no forbidden promo-state mutations', () => {
  assert.match(promoSource, /grid-template-columns:minmax\(0,1fr\) auto auto/);
  assert.match(promoSource, /@media\(max-width:420px\)[\s\S]*?minmax\(0,1fr\) minmax\(0,1fr\)/);
  assert.match(promoSource, /@media\(max-width:640px\)[\s\S]*?font-size:16px/);
  assert.match(promoSource, /min-height:44px/);
  assert.match(promoSource, /focus-visible/);
  assert.doesNotMatch(promoSource, /delete\s+(?:window\.)?tcart\.promocode/);
  assert.doesNotMatch(promoSource, /(?:window\.)?tcart\.promocode\s*=/);
  assert.doesNotMatch(promoSource, /cartCalculator\.appliedPromocode\s*=/);
  assert.doesNotMatch(promoSource, /prodamount_(?:discountsum|withdiscount)\s*=/);
  assert.doesNotMatch(promoSource, /localStorage\s*\./);
  assert.doesNotMatch(promoSource, /window\.t_cart__promocode/);
});
// End of the isolated promo recovery regression suite.
