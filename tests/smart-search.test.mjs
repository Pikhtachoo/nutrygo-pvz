import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'js/ngr-stock.js'), 'utf8');
const start = source.indexOf('  function smartNorm(');
const end = source.indexOf('  function loadSmartIndex(', start);
assert.ok(start > -1 && end > start, 'pure ranking helpers must be present');

const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);

function best(item, query) {
  const q = context.smartNorm(query);
  const variants = [q, context.keyboardVariant(q), context.translitVariant(q)].filter(Boolean);
  return variants.reduce((winner, variant) => {
    const ranked = context.rankSmart(item, variant);
    return ranked && (!winner || ranked.score > winner.score) ? ranked : winner;
  }, null);
}

const magnesium = {
  a: 'SKU-2048',
  t: 'NOW Magnesium Citrate, 200 mg',
  b: 'NOW Foods',
  s: 'now magnesium citrate магний цитрат минерал поддержка мышц',
};

test('exact article and title outrank generic description matches', () => {
  assert.equal(best(magnesium, 'SKU-2048').match, 'Артикул');
  const exact = best(magnesium, 'NOW Magnesium Citrate, 200 mg');
  const generic = best(magnesium, 'мышц');
  assert.ok(exact.score > generic.score);
});

test('description-only term is searchable', () => {
  const beta = {
    a: '33457', t: 'NOW Beta-Carotene', b: 'NOW Foods',
    s: 'now beta carotene бета каротин криптоксантин антиоксидант',
  };
  const ranked = best(beta, 'криптоксантин');
  assert.ok(ranked && ranked.score > 0);
  assert.equal(ranked.match, 'Описание');
});

test('wrong keyboard layout, transliteration and one-edit typo remain findable', () => {
  assert.ok(best(magnesium, 'vfuybq'), 'wrong-layout magnesium');
  assert.ok(best(magnesium, 'magnesiun'), 'one-edit typo');
  const beta = { a: '33457', t: 'Beta-Carotene', b: 'NOW', s: 'бета каротин криптоксантин' };
  assert.ok(best(beta, 'beta karotin'), 'Latin transliteration');
});

test('ranking evaluates all candidates before applying the result limit', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    a: String(i), t: `Generic ${i}`, b: 'Brand', s: 'обычный товар',
  }));
  rows[39] = { a: 'winner', t: 'Магний цитрат', b: 'NOW', s: 'магний цитрат' };
  const ranked = rows
    .map((item) => ({ item, ranked: best(item, 'магний') }))
    .filter((row) => row.ranked)
    .sort((a, b) => b.ranked.score - a.ranked.score)
    .slice(0, 10);
  assert.equal(ranked[0].item.a, 'winner');
});
