import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Компонент промокода ОТКЛЮЧЁН 12.08.2026 после инцидента с «полуприменённым»
// промокодом: пересозданное им поле приводило к состоянию, когда Tilda рисовала
// скидку в итогах, но не записывала её в корзину — покупатель видел цену со
// скидкой, а к оплате уходила полная. Пока компонент не переработан под живым
// браузером, промокодами управляет только штатный поток Tilda. Эти тесты
// охраняют выключенное состояние и запрет на вмешательство в корзину.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'js/ngr-stock.js'), 'utf8');
const promoSource = source.slice(
  source.indexOf('NGR_PROMO_RECOVERY_BEGIN'),
  source.indexOf('NGR_PROMO_RECOVERY_END'),
);

test('promo recovery stays disabled until it is rebuilt against a live browser', () => {
  assert.match(promoSource, /var PROMO_RECOVERY_ENABLED = false;/,
    'The kill switch must stay off — see the 12.08 half-applied promo incident.');
  assert.match(promoSource, /function fixPromocode\(\) \{\n\s*if \(!PROMO_RECOVERY_ENABLED\) return;/,
    'fixPromocode must exit before touching the native Tilda promo field.');
});

test('the component never writes into the Tilda cart', () => {
  assert.doesNotMatch(promoSource, /delete\s+(?:window\.)?tcart\.promocode/);
  assert.doesNotMatch(promoSource, /(?:window\.)?tcart\.promocode\s*=/);
  assert.doesNotMatch(promoSource, /prodamount_(?:discountsum|withdiscount)\s*=/);
  assert.doesNotMatch(promoSource, /tcart\.(?:amount|prodamount|total)\s*=/);
});
