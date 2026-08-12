import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Зеркало заказа (12.08.2026): сервер Tilda перестал доносить вебхук заказа
// до интегратора, поэтому копию заказа отправляет браузер покупателя.
// Главное требование — ПАССИВНОСТЬ: оригинальный запрос Tilda не меняется,
// не блокируется и не зависит от нашей логики. Эти тесты охраняют контракт.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(resolve(root, 'js/ngr-stock.js'), 'utf8');
const mirrorSource = source.slice(
  source.indexOf('NGR_ORDER_MIRROR_BEGIN'),
  source.indexOf('NGR_ORDER_MIRROR_END'),
);

test('весь клиентский файл синтаксически корректен', () => {
  // Файл уходит в браузеры покупателей как есть: синтаксическая ошибка
  // убила бы разом витрину, остатки, ПВЗ и оформление.
  assert.doesNotThrow(() => new Function(source));
});

test('компонент зеркала присутствует и защищён от повторной установки', () => {
  assert.ok(mirrorSource.length > 100, 'Блок NGR_ORDER_MIRROR должен быть в файле.');
  assert.match(mirrorSource, /if \(window\.NGR_ORDER_MIRROR\) return;/);
});

test('обёртки XHR и fetch пассивны: оригинальный вызов выполняется всегда', () => {
  assert.match(mirrorSource, /return origOpen\.apply\(this, arguments\);/);
  assert.match(mirrorSource, /return origSend\.apply\(this, arguments\);/);
  assert.match(mirrorSource, /var result = origFetch\.apply\(this, arguments\);/);
  assert.match(mirrorSource, /return result;/);
  // Вся наша логика в send/fetch — внутри try/catch, до/после оригинала.
  const sendWrapper = mirrorSource.slice(
    mirrorSource.indexOf('XMLHttpRequest.prototype.send = function'),
    mirrorSource.indexOf('return origSend.apply'),
  );
  assert.match(sendWrapper, /try \{/);
  assert.match(sendWrapper, /catch \(e\) \{\}/);
});

test('зеркалится только заказ: телефон в форме и товары в корзине', () => {
  assert.match(mirrorSource, /params\.get\('Phone'\) \|\| params\.get\('phone'\)/);
  assert.match(mirrorSource, /if \(!snap\) return;/);
  assert.match(mirrorSource, /xhr\.status === 200/);
  assert.match(mirrorSource, /res\.status !== 200/);
});

test('снимок корзины берётся в момент отправки, а не после ответа', () => {
  const sendWrapper = mirrorSource.slice(
    mirrorSource.indexOf('XMLHttpRequest.prototype.send = function'),
    mirrorSource.indexOf('return origSend.apply'),
  );
  assert.match(sendWrapper, /var snap = cartSnapshot\(\);/,
    'Tilda чистит корзину после успеха — снимок нужен до запроса.');
});

test('доставка переживает уход на оплату: sendBeacon с запасным fetch keepalive', () => {
  assert.match(mirrorSource, /navigator\.sendBeacon/);
  assert.match(mirrorSource, /keepalive: true/);
});

test('зеркало не пишет в корзину и не трогает членские API', () => {
  assert.doesNotMatch(mirrorSource, /tcart\.\w+\s*=/,
    'Читать tcart можно, писать — нельзя (урок промо-компонента 12.08).');
  assert.doesNotMatch(mirrorSource, /members\.tildaapi/,
    'Логин и профиль не зеркалим.');
  assert.match(mirrorSource, /procces/,
    'Фильтр по форменному эндпоинту Tilda (с их опечаткой в пути).');
});
