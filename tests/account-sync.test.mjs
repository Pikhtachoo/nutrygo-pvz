import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'js/ngr-stock.js'), 'utf8');

function functionSource(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `Expected ${name}().`);
  const brace = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  assert.fail(`No closing brace for ${name}().`);
}

test('cached Tilda profile is never accepted as authentication', () => {
  const member = functionSource('member');
  assert.match(member, /!tok\s*\|\|\s*!accountVerified\s*\|\|\s*accountToken\s*!==\s*tok/);
  assert.doesNotMatch(member, /!tok\s*&&\s*!p/);
  assert.match(functionSource('applyAccountSnapshot'), /fixAuthGate\s*\(\s*\)/,
    'Successful verification must reopen checkout without waiting for another DOM mutation.');
});

test('profile and favorites use the token-only account API and scoped cache', () => {
  const post = functionSource('accountPost');
  assert.match(post, /memberToken\s*\(\)/);
  assert.match(post, /\/account\/state/);
  assert.match(post, /body\.token\s*=\s*token/);
  assert.doesNotMatch(source, /fetch\([^\n]*\/profile\/me/,
    'The client must never fall back to the raw-login profile endpoint.');
  assert.match(source, /base\s*\+\s*['"]:['"]\s*\+\s*accountSubject/);
  assert.match(functionSource('favList'), /verifiedAccountToken\s*\(\s*\)/,
    'A token waiting for verification must never read the previous account namespace.');
  assert.match(source, /Перенести их именно в текущий аккаунт/,
    'Legacy device favorites require explicit account attribution.');
  assert.match(source, /Перенести фото с этого устройства/,
    'Legacy photos require an explicit upload action.');
});

test('official Tilda profile storage supplies the token before cart UI opens', () => {
  const context = vm.createContext({
    window: {}, TP: '27635446',
    localStorage: {
      getItem: (key) => key === 'tilda_members_profile27635446'
        ? JSON.stringify({ token: 'verified-later-by-worker' }) : null,
    },
    document: { querySelector: () => null },
  });
  vm.runInContext(functionSource('memberToken'), context);
  assert.equal(context.memberToken(), 'verified-later-by-worker');
  assert.match(functionSource('memberToken'), /tilda_members_profile['"]\s*\+\s*TP/);
});

test('late account responses cannot cross an account switch', () => {
  const writes = [];
  const context = vm.createContext({
    accountVerified: true,
    accountSubject: 'subject-A',
    accountToken: 'token-B-0123456789',
    memberToken: () => 'token-B-0123456789',
    localStorage: { setItem: (...args) => writes.push(args) },
    paintMe() {}, fixAccountButton() {}, paintFavoriteButtons() {}, fixAuthGate() {},
  });
  vm.runInContext(functionSource('accountCacheKey'), context);
  vm.runInContext(functionSource('applyAccountSnapshot'), context);

  const stale = context.applyAccountSnapshot({
    token: 'token-A-0123456789',
    snapshot: { subject: 'subject-A-late', profile: { nick: 'A' }, favorites: ['1'] },
  });
  assert.equal(stale, null);
  assert.equal(context.accountSubject, 'subject-A');
  assert.equal(writes.length, 0);

  const current = context.applyAccountSnapshot({
    token: 'token-B-0123456789',
    snapshot: { subject: 'subject-B', profile: { nick: 'B' }, favorites: ['2'] },
  });
  assert.equal(current.subject, 'subject-B');
  assert.equal(context.accountSubject, 'subject-B');
  assert.equal(writes.length, 2);
});

test('favorite mutations are synchronized as add/remove operations', () => {
  const toggle = functionSource('favToggle');
  assert.match(toggle, /accountPost\(\s*['"]favorite['"]/);
  assert.match(toggle, /id:\s*String\(a\),\s*on:\s*on/);
  assert.match(toggle, /memberToken\(\)\s*!==\s*intentToken/,
    'A favorite click must not migrate to a different token after an account switch.');
  assert.doesNotMatch(toggle, /body:\s*JSON\.stringify\([^)]*login/);
});

test('Tilda history and integrator delivery status merge by exact order id', () => {
  const start = source.indexOf('  var STATUS_RU = ');
  const end = source.indexOf('  function cabSection(', start);
  assert.ok(start > -1 && end > start);
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);

  const native = {
    last_orders: [{ id: 'A-1', date: '2026-08-01', amount: 900, status: 'paid', products: [] }],
    last_purchases: [{ name: 'Native product' }],
  };
  const worker = {
    orders: [
      { id: 'A-1', at: '2026-08-01', amount: 900, status: 'delivery_created', items: [{ name: 'One', sku: '11', qty: 2 }] },
      { id: 'B-2', at: '2026-08-02', amount: 500, status: 'awaiting_payment', items: [] },
    ],
  };
  const merged = context.mergeOrderDashboard(native, worker);
  assert.equal(merged.last_orders.length, 2);
  const first = merged.last_orders.find((row) => row.id === 'A-1');
  assert.equal(first.status, 'paid', 'Payment/order status remains Tilda-owned.');
  assert.equal(first.delivery_status, 'delivery_created');
  assert.equal(first.items[0].quantity, 2);
  assert.equal(context.orderStatus(first), 'Передан в Ozon Доставку');
  assert.deepEqual(merged.last_purchases, native.last_purchases);
});

test('orders API is called with token and no cache', () => {
  const load = functionSource('loadIntegratorOrders');
  assert.match(load, /\/orders\/my/);
  assert.match(load, /JSON\.stringify\(\s*\{\s*token:\s*token\s*\}\s*\)/);
  assert.match(load, /cache:\s*['"]no-store['"]/);
  assert.match(source,
    /mergeOrderDashboard\(\(res\[1\]\s*&&\s*res\[1\]\.data\)\s*\|\|\s*res\[1\]\s*\|\|\s*\{\},\s*res\[3\]\)/,
    'Both root and data-wrapped Tilda dashboard responses must be supported.');
  assert.match(source, /href="\/members\/"[\s\S]*Открыть полную историю заказов/,
    'Orders older than the recent dashboard/Worker window need a durable history route.');
});
