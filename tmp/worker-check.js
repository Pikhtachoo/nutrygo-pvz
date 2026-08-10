/**
 * Интегратор nutry-go.ru <-> Ozon Доставка (Cloudflare Worker).
 *
 * Делает то, ради чего всё затевалось: оплаченный заказ с сайта сам
 * превращается в отправление Ozon Доставки.
 *
 * Поток:
 *   1. Корзина Tilda шлёт данные заказа на /tilda/order (поле «Свой скрипт
 *      для принятия данных»). Заказ сохраняется в KV как «ожидает оплаты».
 *   2. Ozon Pay шлёт уведомление об оплате на /ozonpay/webhook. Воркер
 *      сверяет статус заказа напрямую у Ozon Pay (не верит вебхуку на слово),
 *      находит заказ в KV, достаёт телефон, номер пункта и товары.
 *   3. Чекаут (v2/delivery/checkout) -> создание заказа (v2/order/create).
 *      Пока DRY_RUN=yes — только чекаут, создание пропускается (обкатка).
 *
 * Токен Seller API обновляется сам по refresh_token (grant offline).
 *
 * Секреты (wrangler secret / API):
 *   OZON_APP_CLIENT_ID, OZON_APP_CLIENT_SECRET  — частное приложение (2489545)
 *   OZON_REFRESH_TOKEN                          — стартовый refresh-токен
 *   OZONPAY_ACCESS_KEY, OZONPAY_SECRET_KEY      — эквайринг (проверка статуса)
 * Переменные: DRY_RUN ("yes"/"no"), MANAGER_CHAT (опц., Telegram "token:chatId")
 * KV-биндинг: ORDERS
 */

import PVZ_PICKER from './pvz-picker.js';
import LK_ORDERS from './lk-orders.js';
import STOCK_GUARD from './ngr-stock.js';

const VERSION = 'block-undeliverable-1';
const XAPI = 'https://xapi.ozon.ru/oauth/token';
const SELLER = 'https://api-seller.ozon.ru';
const PAYAPI = 'https://payapi.ozon.ru/v1/getOrderStatus';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // Версию показываем, чтобы видеть, докатилось ли обновление:
      // Cloudflare раскатывает новую версию не мгновенно.
      if (url.pathname === '/health') return json({ ok: true, dry_run: env.DRY_RUN !== 'no', version: VERSION });
      // Скрипты сайта отдаём отсюда: обновление мгновенное, в отличие от
      // пересборки справочника из 16 тысяч файлов на статическом хостинге.
      if (url.pathname === '/js/pvz-picker.js') return script(PVZ_PICKER);
      if (url.pathname === '/js/lk-orders.js') return script(LK_ORDERS);
      if (url.pathname === '/js/ngr-stock.js') return script(STOCK_GUARD);
      // Основной код оформления сайта: вынесен из шапки Tilda, где он занимал
      // 56 КБ из 64 доступных и заставлял страницу перерисовываться на глазах
      // у покупателя. Хранится в KV, чтобы обновлять без перевыпуска воркера.
      if (url.pathname === '/js/ngr-main.js') {
        const code = await env.ORDERS.get('asset:ngr-main');
        return code ? script(code) : new Response('/* not uploaded */', { status: 404 });
      }
      // Раздача произвольного файла из KV (например, CSV каталога для импорта
      // в Tilda: страница админки забирает его отсюда, минуя ручную загрузку).
      if (url.pathname.startsWith('/file/')) {
        const name = url.pathname.slice(6);
        if (!/^[a-z0-9.-]+$/.test(name) || name.includes('..')) return json({ error: 'bad name' }, 400);
        // Кэш на границе Cloudflare: без него каждое обращение шло в KV
        // и картинка карточки бренда грузилась по десять секунд.
        const cacheKey = new Request(url.origin + url.pathname);
        const cached = await caches.default.match(cacheKey);
        if (cached) return cached;
        const body = await env.ORDERS.get('asset:' + name, 'arrayBuffer');
        if (!body) return json({ error: 'not found' }, 404);
        const mime = name.endsWith('.png') ? 'image/png'
          : name.endsWith('.jpg') ? 'image/jpeg'
          : 'application/octet-stream';
        const resp = new Response(body, {
          headers: {
            'Content-Type': mime,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400'
          }
        });
        ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
        return resp;
      }
      if (url.pathname === '/admin/put' && request.method === 'POST') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        const name = url.searchParams.get('name') || '';
        if (!/^[a-z0-9-]+$/.test(name)) return json({ error: 'bad name' }, 400);
        const text = await request.text();
        await env.ORDERS.put('asset:' + name, text);
        return cors(json({ ok: true, name, len: text.length }));
      }
      if (url.pathname === '/admin/put' && request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      // Полный ответ Ozon на расчёт — чтобы видеть причину отказа целиком
      if (url.pathname === '/admin/checkout' && request.method === 'POST') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        const body = await request.json();
        const token = await sellerToken(env);
        const r = await sellerCall(env, token, '/v2/delivery/checkout', body);
        return json(r);
      }
      // Диагностика приёма заказов: пишем каждое обращение, даже пустое или
      // с неизвестными полями — иначе не видно, доходит ли Tilda до нас вообще.
      if (url.pathname === '/tilda/order') {
        const body = request.method === 'POST' ? await request.clone().text() : '';
        ctx.waitUntil(env.ORDERS.put('hit:' + Date.now(), JSON.stringify({
          at: new Date().toISOString(),
          method: request.method,
          ua: (request.headers.get('User-Agent') || '').slice(0, 80),
          ct: request.headers.get('Content-Type') || '',
          body: body.slice(0, 3000)
        }), { expirationTtl: 86400 * 3 }));
        if (request.method === 'POST') return await tildaOrder(request, env, ctx);
        return json({ ok: true, hint: 'приём заказов работает' });
      }
      // Какие товары кабинета сейчас нельзя продать. Сайт берёт этот список и
      // гасит такие карточки: витрина Tilda — копия остатков, а решает Ozon.
      if (url.pathname === '/catalog/unavailable') {
        const snap = await env.ORDERS.get('catalog:unavailable');
        if (!snap) {
          ctx.waitUntil(refreshAvailability(env));
          return cors(json({ updated: null, offers: [], building: true }));
        }
        return cors(json(JSON.parse(snap)));
      }
      // Живые остатки FBS по артикулам. Каталог Tilda обновляется файлом раз
      // в неделю и к концу недели врёт; сайт берёт этот снимок и показывает
      // наличие по нему. Обновляется по расписанию, отдаётся из кеша.
      if (url.pathname === '/catalog/stock') {
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;
        const snap = await env.ORDERS.get('catalog:stock');
        if (!snap) {
          ctx.waitUntil(refreshStock(env));
          return cors(json({ updated: null, stock: {}, building: true }));
        }
        const res = cors(json(JSON.parse(snap)));
        res.headers.set('Cache-Control', 'public, max-age=300');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      // Отзывы. Без параметров — короткая сводка на все товары (её сайт грузит
      // один раз и рисует звёзды на карточках). С ?sku= — тексты по одному
      // товару для его карточки.
      if (url.pathname === '/catalog/reviews') {
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;
        const raw = await env.ORDERS.get('catalog:reviews');
        if (!raw) {
          ctx.waitUntil(refreshReviews(env));
          return cors(json({ updated: null, building: true }));
        }
        const st = JSON.parse(raw);
        const one = url.searchParams.get('sku');
        let out;
        if (one) {
          const it = (st.items || {})[String(one)];
          if (it) {
            // Фото покупателей подтягиваем по требованию: адреса снимков есть
            // только в отдельном методе, и дёргать его на все 30 тысяч отзывов
            // ради товаров, которые никто не открывал, бессмысленно.
            const need = (it.t || []).filter(r => r.p > 0 && !r.ph).slice(0, 4);
            if (need.length) {
              const token = await sellerToken(env);
              for (const r of need) {
                const info = await sellerCall(env, token, '/v1/review/info', { review_id: r.id });
                r.ph = ((info && info.photos) || []).slice(0, 4).map(p => String(p.url || ''));
              }
              ctx.waitUntil(env.ORDERS.put('catalog:reviews', JSON.stringify(st)));
            }
          }
          out = it
            ? { sku: one, n: it.n, avg: Math.round((it.s / it.n) * 10) / 10, list: it.t }
            : { sku: one, n: 0, avg: 0, list: [] };
        } else {
          // Компактно: артикул → [сколько, средняя×10]. Так вся витрина
          // укладывается в несколько десятков килобайт.
          const m = {};
          Object.keys(st.items || {}).forEach(sku => {
            const it = st.items[sku];
            if (!it.n) return;
            m[sku] = [it.n, Math.round((it.s / it.n) * 10)];
          });
          out = { updated: st.updated, ready: !st.last_id, rating: m };
        }
        const res = cors(json(out));
        res.headers.set('Cache-Control', 'public, max-age=600');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      // Заказы покупателя для личного кабинета на сайте.
      //
      // Отдаём только свои: токен кабинета подтверждаем у Tilda и сверяем
      // почту с той, на которую оформлен заказ. Без подтверждения не отдаём
      // ничего — в заказах адрес, телефон и состав покупки.
      if (url.pathname === '/orders/my' && request.method === 'OPTIONS') {
        return cors(new Response(null, { status: 204 }));
      }
      if (url.pathname === '/orders/my' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const who = await verifyMember(env, String(body.token || ''), true);
        if (!who.ok || !who.login) return cors(json({ error: 'нужен вход в кабинет' }, 401));
        const mine = String(who.login).toLowerCase();
        const myPhone = String(who.phone || '').replace(/\D/g, '').slice(-10);

        const list = await env.ORDERS.list({ prefix: 'order:' });
        const out = [];
        for (const k of list.keys) {
          const raw = await env.ORDERS.get(k.name);
          if (!raw) continue;
          let o;
          try { o = JSON.parse(raw); } catch (e) { continue; }
          // Сверяем по трём приметам: кабинет заказа, почта и телефон.
          // Почта в заказе может отличаться от почты кабинета — покупатель
          // вводит её руками и опечатывается (так и вышло с первым заказом).
          const mail = String(o.email || '').toLowerCase();
          const phone = String(o.phone || '').replace(/\D/g, '').slice(-10);
          const member = String(o.member_login || '').toLowerCase();
          const same = (member && member === mine) || mail === mine ||
            (myPhone && phone && phone === myPhone);
          if (!same) continue;
          out.push({
            id: o.ext_id || k.name.slice(6),
            at: o.received_at || '',
            amount: Number(o.amount) || 0,
            status: o.status || '',
            city: o.city || '',
            address: o.address || '',
            point: o.point_id || null,
            ozon_order: o.ozon_order || '',
            items: (o.items || []).map(i => ({
              name: i.name || '', sku: String(i.sku || i.offer_id || ''),
              qty: Number(i.quantity) || 1, price: Number(i.price) || 0
            }))
          });
        }
        out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return cors(json({ login: who.login, orders: out }));
      }
      // Собственная карточка товара: всё, что нужно окну на сайте, одним
      // ответом. Раньше сайт умел открывать товар только через каталог
      // Tilda, а тот держит в памяти лишь несколько карточек — с полок
      // товар открыть не удавалось (решение Александра 08.08).
      if (url.pathname === '/catalog/product') {
        let offer = String(url.searchParams.get('offer') || '').trim();
        const byUid = String(url.searchParams.get('uid') || '').trim();
        if (!offer && !byUid) return cors(json({ error: 'нужен артикул' }, 400));
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;

        const idxRaw = await env.ORDERS.get('catalog:index');
        const idx = idxRaw ? JSON.parse(idxRaw).items || {} : {};
        // В заказах Tilda у товара может не быть артикула, зато есть её
        // внутренний номер — ищем по нему, иначе карточка из кабинета
        // не открывалась (замечание Александра 08.08).
        if (!offer && byUid) {
          offer = Object.keys(idx).find(a => idx[a].uid === byUid) || '';
          if (!offer) return cors(json({ error: 'товар не найден', uid: byUid }, 404));
        }
        const it = idx[offer];
        if (!it) return cors(json({ error: 'товар не найден', offer }, 404));

        const stockRaw = await env.ORDERS.get('catalog:stock');
        const st = stockRaw ? JSON.parse(stockRaw) : { stock: {}, sku: {} };
        const ozonSku = (st.sku || {})[offer] || '';

        const revRaw = await env.ORDERS.get('catalog:reviews');
        const rev = revRaw ? JSON.parse(revRaw) : { items: {} };
        const r = ozonSku ? (rev.items || {})[ozonSku] : null;

        const sgrRaw = await env.ORDERS.get('catalog:sgr');
        const sgr = sgrRaw ? (JSON.parse(sgrRaw).sgr || {}) : {};

        // Фото Ozon: если ещё не собирали — берём сейчас, они у карточки главные.
        let photos = [];
        const phRaw = await env.ORDERS.get('photos:' + offer);
        if (phRaw) photos = JSON.parse(phRaw).photos || [];
        else {
          try {
            const token = await sellerToken(env);
            const info = await sellerCall(env, token, '/v3/product/info/list', { offer_id: [offer] });
            const pi = (info && info.items && info.items[0]) || null;
            if (pi) {
              [].concat(pi.primary_image || []).forEach(u => { if (u) photos.push(String(u)); });
              (pi.images || []).forEach(u => { if (u && photos.indexOf(String(u)) < 0) photos.push(String(u)); });
            }
            photos = photos.slice(0, 8);
            ctx.waitUntil(env.ORDERS.put('photos:' + offer, JSON.stringify({ offer, photos }), { expirationTtl: 86400 * 7 }));
          } catch (e) { photos = []; }
        }

        let text = '';
        try {
          const tb = await env.ORDERS.get('catalog:text:' + offer.slice(-1));
          if (tb) text = JSON.parse(tb)[offer] || '';
        } catch (e) {}

        const out = {
          art: offer,
          title: it.t,
          text: text,
          price: it.p,
          old: it.o > it.p ? it.o : 0,
          off: it.o > it.p ? Math.round((it.o - it.p) / it.o * 100) : 0,
          photos: photos.length ? photos : it.g,
          uid: it.uid,
          url: it.url,
          unit: it.unit,
          portion: it.portion,
          pack: it.pk,
          left: Number((st.stock || {})[offer] || 0),
          sgr: sgr[offer] || '',
          reviews: r ? { n: r.n, avg: Math.round((r.s / r.n) * 10) / 10, list: (r.t || []).slice(0, 12) } : { n: 0, avg: 0, list: [] }
        };
        const res = cors(json(out));
        res.headers.set('Cache-Control', 'public, max-age=600');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      // Поиск товара по названию. В заказах Tilda у позиции может не быть
      // ни артикула, ни внутреннего номера — тогда из кабинета товар
      // открывается по названию (замечание Александра 08.08).
      if (url.pathname === '/catalog/find') {
        const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
        if (q.length < 4) return cors(json({ error: 'слишком короткий запрос' }, 400));
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;
        const idxRaw = await env.ORDERS.get('catalog:index');
        const idx = idxRaw ? JSON.parse(idxRaw).items || {} : {};
        let best = '', bestScore = 0;
        for (const art of Object.keys(idx)) {
          const title = String(idx[art].t || '').toLowerCase();
          if (!title) continue;
          let score = 0;
          if (title === q) score = 1000;
          else if (title.indexOf(q) === 0) score = 500;
          else if (title.indexOf(q) > -1 || q.indexOf(title) > -1) score = 200;
          else {
            // Считаем совпавшие слова — названия в заказе бывают обрезаны.
            const words = q.split(/[\s,]+/).filter(w => w.length > 3);
            words.forEach(w => { if (title.indexOf(w) > -1) score += 10; });
          }
          if (score > bestScore) { bestScore = score; best = art; }
        }
        const res = cors(json(best ? { art: best, title: idx[best].t } : { error: 'не найдено' }));
        res.headers.set('Cache-Control', 'public, max-age=3600');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      // Номера свидетельств о государственной регистрации по артикулам.
      // Справочник присылает Александр файлом; здесь он только раздаётся.
      if (url.pathname === '/catalog/sgr') {
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;
        const raw = await env.ORDERS.get('catalog:sgr');
        if (!raw) return cors(json({ sgr: {}, total: 0 }));
        const res = cors(new Response(raw, { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
        res.headers.set('Cache-Control', 'public, max-age=86400');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      // Подборки для главной: больше всего отзывов и максимальная скидка.
      if (url.pathname === '/catalog/search') {
        const res = cors(await catalogSearch(request, env));
        res.headers.set('Cache-Control', 'public, max-age=300');
        return res;
      }
      // Значения фильтров, у которых есть товар в наличии.
      if (url.pathname === '/catalog/facets') {
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;
        const raw = await env.ORDERS.get('catalog:facets');
        if (!raw) {
          ctx.waitUntil(refreshShelves(env));
          return cors(json({ updated: null, building: true, groups: {} }));
        }
        const res = cors(json(JSON.parse(raw)));
        res.headers.set('Cache-Control', 'public, max-age=900');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      if (url.pathname === '/catalog/shelves') {
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;
        const raw = await env.ORDERS.get('catalog:shelves');
        if (!raw) {
          ctx.waitUntil(refreshShelves(env));
          return cors(json({ updated: null, building: true, byReviews: [], byDiscount: [] }));
        }
        const res = cors(json(JSON.parse(raw)));
        res.headers.set('Cache-Control', 'public, max-age=900');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      // Все фото товара из Ozon. Tilda отдаёт карточке только два снимка,
      // причём второй часто не открывается — покупатель видел серый экран.
      // Берём по требованию для открытого товара и запоминаем на неделю.
      if (url.pathname === '/catalog/photos') {
        const offer = String(url.searchParams.get('offer') || '').trim();
        if (!offer) return cors(json({ error: 'нужен артикул' }, 400));
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;
        const kvKey = 'photos:' + offer;
        let saved = await env.ORDERS.get(kvKey);
        if (!saved) {
          const token = await sellerToken(env);
          const info = await sellerCall(env, token, '/v3/product/info/list', { offer_id: [offer] });
          const it = (info && info.items && info.items[0]) || null;
          const list = [];
          if (it) {
            [].concat(it.primary_image || []).forEach(u => { if (u) list.push(String(u)); });
            (it.images || []).forEach(u => { if (u && list.indexOf(String(u)) < 0) list.push(String(u)); });
          }
          saved = JSON.stringify({ offer: offer, photos: list.slice(0, 8) });
          await env.ORDERS.put(kvKey, saved, { expirationTtl: 86400 * 7 });
        }
        const res = cors(json(JSON.parse(saved)));
        res.headers.set('Cache-Control', 'public, max-age=86400');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      // Человеческая страница состояния: заполнились ли отзывы, свежие ли
      // остатки. Чтобы не спрашивать и не лезть в служебные ответы.
      if (url.pathname === '/status') {
        const rv = JSON.parse((await env.ORDERS.get('catalog:reviews')) || '{}');
        const stk = JSON.parse((await env.ORDERS.get('catalog:stock')) || '{}');
        const items = rv.items || {};
        const skus = Object.keys(items);
        const totalRev = skus.reduce((a, k) => a + (items[k].n || 0), 0);
        const withText = skus.filter(k => (items[k].t || []).length).length;
        const done = !rv.last_id && skus.length > 0;
        const ago = t => {
          if (!t) return 'ещё не собирали';
          const m = Math.round((Date.now() - Date.parse(t)) / 60000);
          if (m < 1) return 'только что';
          if (m < 60) return m + ' мин назад';
          return Math.round(m / 60) + ' ч назад';
        };
        const inStock = Object.keys(stk.stock || {}).length;
        const html =
          '<!doctype html><meta charset="utf-8">' +
          '<meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>NutryGo — что сейчас происходит</title>' +
          '<style>body{margin:0;padding:22px;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;' +
          'background:#f6f8fa;color:#14171c}h1{font-size:20px;margin:0 0 18px}' +
          '.c{background:#fff;border:1px solid #e6eaef;border-radius:14px;padding:16px 18px;margin-bottom:14px}' +
          '.c h2{font-size:15px;margin:0 0 10px;color:#6b7280;font-weight:600}' +
          '.big{font-size:30px;font-weight:800;letter-spacing:-.5px}' +
          '.ok{color:#1a8f4c;font-weight:700}.wait{color:#c47b12;font-weight:700}' +
          '.s{font-size:14px;color:#6b7280;margin-top:6px}' +
          '.bar{height:9px;border-radius:6px;background:#eef1f5;overflow:hidden;margin:10px 0 4px}' +
          '.bar i{display:block;height:100%;background:#ff7a1a}</style>' +
          '<h1>NutryGo — что сейчас происходит</h1>' +
          '<div class="c"><h2>Отзывы покупателей</h2>' +
          '<div class="big">' + totalRev.toLocaleString('ru-RU') + '</div>' +
          '<div class="s">собрано отзывов по ' + skus.length + ' товарам, из них с текстом — ' + withText + '</div>' +
          '<div class="bar"><i style="width:' + Math.min(100, Math.round(totalRev / 29561 * 100)) + '%"></i></div>' +
          '<div class="s">' + (done
            ? '<span class="ok">✓ Собраны полностью.</span> Дальше обновляются раз в сутки.'
            : '<span class="wait">Сбор идёт.</span> Пополняется каждые 2 минуты, обновите страницу позже.') +
          '</div><div class="s">Последнее пополнение: ' + ago(rv.updated) + '</div></div>' +
          '<div class="c"><h2>Остатки товаров</h2>' +
          '<div class="big">' + inStock + '</div>' +
          '<div class="s">позиций в наличии из ' + (stk.total || 0) + '</div>' +
          '<div class="s">Обновлены: ' + ago(stk.updated) + ' — дальше сами, каждые 20 минут</div></div>';
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      // Какие права реально в токене и открыты ли отзывы. Секретов не отдаёт —
      // только названия областей доступа и код ответа Ozon.
      if (url.pathname === '/diag/scopes') {
        const token = await sellerToken(env);
        let scopes = [];
        try {
          const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          const claims = JSON.parse(atob(part + '==='.slice((part.length + 3) % 4)));
          scopes = [].concat(claims.scope || claims.scp || []);
        } catch (e) { scopes = ['не удалось разобрать токен']; }
        const probe = {};
        for (const [name, path, body] of [
          ['отзывы', '/v1/review/count', {}],
          ['сертификаты', '/v1/product/certificate/list', { page: 1, page_size: 1 }],
          ['категории', '/v1/description-category/tree', { language: 'RU' }]
        ]) {
          const r = await sellerCall(env, token, path, body);
          probe[name] = (r && r.message) ? r.message : 'доступно';
        }
        return cors(json({ scopes, probe }));
      }
      // Повторить создание отправления по оплаченному заказу — например,
      // после того как товар вернули в продажу.
      if (url.pathname === '/admin/retry') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        const ext = url.searchParams.get('ext') || '';
        const raw = await env.ORDERS.get('order:' + ext);
        if (!raw) return json({ error: 'заказ не найден' }, 404);
        const o = JSON.parse(raw);
        await createDelivery(env, ext, o);
        const after = JSON.parse(await env.ORDERS.get('order:' + ext));
        return json({ ext, status: after.status, ozon_order: after.ozon_order || null, trace: after.trace });
      }
      if (url.pathname === '/admin/refresh-catalog') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        return json(await refreshAvailability(env));
      }
      // Обновить остатки не дожидаясь расписания — например, сразу после
      // ручной заливки каталога.
      if (url.pathname === '/admin/refresh-stock') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        return json(await refreshStock(env));
      }
      if (url.pathname === '/ozonpay/webhook' && request.method === 'POST') return await paymentWebhook(request, env, ctx);
      // Запросы покупателя из личного кабинета сайта
      if (url.pathname === '/order/request' && request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (url.pathname === '/order/request' && request.method === 'POST') return cors(await orderRequest(request, env, ctx));
      // Сроки доставки Ozon для выбранного пункта — их показываем покупателю
      // Личные настройки покупателя: псевдоним и аватар
      if (url.pathname === '/profile/me' && request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (url.pathname === '/profile/me' && request.method === 'GET') return cors(await profileGet(request, env));
      if (url.pathname === '/profile/me' && request.method === 'POST') return cors(await profileSet(request, env));
      if (url.pathname === '/delivery/eta' && request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (url.pathname === '/delivery/eta' && request.method === 'POST') return cors(await deliveryEta(request, env));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.log('ошибка:', e.message);
      return json({ error: 'internal' }, 500);
    }
  },

  /**
   * Раз в 5 минут сами спрашиваем Ozon Pay, оплачены ли ожидающие заказы.
   * Так связка работает и без вебхука: в кабинете Ozon Банка поля для его
   * адреса нет, а ждать поддержку ради запуска не нужно.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollPayments(env));
    ctx.waitUntil(refreshAvailabilityIfStale(env));
    ctx.waitUntil(refreshStockIfStale(env));
    ctx.waitUntil(refreshReviewsIfStale(env));
    ctx.waitUntil(refreshShelvesIfStale(env));
  }
};

/* ---------- Что сейчас можно продавать ---------- */

/**
 * Снимок «нельзя продать» по кабинету 2489545.
 *
 * Зачем: остатки на витрине Tilda — копия, которая устаревает, а товар,
 * снятый в кабинете с продажи, Ozon отказывается везти (BANNED) уже после
 * оплаты. Один раз в несколько часов спрашиваем сам Ozon и отдаём сайту
 * список артикулов, которые надо погасить.
 */
async function refreshAvailability(env) {
  const token = await sellerToken(env);
  const offers = [];
  let lastId = '';
  for (let page = 0; page < 20; page++) {
    const r = await sellerCall(env, token, '/v3/product/list', {
      filter: { visibility: 'ALL' }, limit: 1000, last_id: lastId
    });
    const items = (r && r.result && r.result.items) || [];
    items.forEach(i => offers.push(String(i.offer_id)));
    lastId = (r && r.result && r.result.last_id) || '';
    if (!items.length || !lastId) break;
  }

  const bad = [];
  for (let i = 0; i < offers.length; i += 100) {
    const info = await sellerCall(env, token, '/v3/product/info/list', { offer_id: offers.slice(i, i + 100) });
    ((info && info.items) || []).forEach(it => {
      const st = it.statuses || {};
      // Пустое описание статуса означает «продаётся»; всё остальное —
      // «нет на складе», «убран из продажи», «обновляется» и т.п.
      if (st.status_description) bad.push(String(it.offer_id));
    });
  }

  const snap = { updated: new Date().toISOString(), total: offers.length, offers: bad };
  await env.ORDERS.put('catalog:unavailable', JSON.stringify(snap));
  return { updated: snap.updated, total: snap.total, unavailable: bad.length };
}

/**
 * Снимок живых остатков FBS.
 *
 * Синхронизацию каталога Tilda пришлось выключить — внешний сборщик склеивал
 * товары в карточки-обёртки и разрушал каталог. Остатки в Tilda теперь
 * обновляются файлом раз в неделю, то есть к концу недели показывают не то.
 * Здесь берём их прямо у Ozon и отдаём сайту, каталог при этом не трогаем.
 *
 * Отдаём только положительные остатки: артикула нет в списке — значит нуль.
 * Так снимок остаётся компактным (около 700 записей вместо 1343).
 */
async function refreshStock(env) {
  const token = await sellerToken(env);
  const stock = {};
  const skuOf = {};   // артикул → SKU: по нему сайт находит отзывы товара
  let cursor = '';
  let total = 0;
  for (let page = 0; page < 10; page++) {
    const r = await sellerCall(env, token, '/v4/product/info/stocks', {
      filter: { visibility: 'ALL' }, limit: 1000, cursor: cursor
    });
    const items = (r && r.items) || [];
    total += items.length;
    items.forEach(it => {
      let free = 0;
      let sku = '';
      (it.stocks || []).forEach(s => {
        if (s.type === 'fbs') free += (Number(s.present) || 0) - (Number(s.reserved) || 0);
        if (!sku && s.sku) sku = String(s.sku);
      });
      if (sku) skuOf[String(it.offer_id)] = sku;
      if (free > 0) stock[String(it.offer_id)] = free;
    });
    cursor = (r && r.cursor) || '';
    if (!items.length || !cursor || items.length < 1000) break;
  }
  // Пустой ответ Ozon не должен обнулить витрину: прошлый снимок надёжнее.
  if (!Object.keys(stock).length) {
    const prev = await env.ORDERS.get('catalog:stock');
    if (prev) return { skipped: 'Ozon вернул пусто, оставили прошлый снимок' };
  }
  const snap = { updated: new Date().toISOString(), total: total, stock: stock, sku: skuOf };
  await env.ORDERS.put('catalog:stock', JSON.stringify(snap));
  return { updated: snap.updated, total: total, inStock: Object.keys(stock).length };
}

/**
 * Полки на главной: «больше всего отзывов» и «максимальная скидка».
 *
 * Раньше в них лежал зашитый список из четырёх товаров. Теперь берём весь
 * каталог сайта (Tilda отдаёт его постранично), оставляем только то, что
 * реально в наличии, и считаем: где больше отзывов и где больше скидка.
 * Пересобирается по расписанию, сайту отдаётся готовый короткий список.
 */
const SHELF_SIZE = 8;

async function refreshShelves(env) {
  const part = env.TILDA_STOREPART || '415554505293';
  const rec = env.TILDA_CATALOG_REC || '2502703571';
  const base = 'https://store.tildaapi.com/api/getproductslist/?storepartuid=' + part + '&recid=' + rec;

  /*
   * Каталог обходим с перечислением всех брендов.
   *
   * У Tilda два указателя, и они расходятся: простой список раздела застрял
   * на 601 карточке из 1343, а поиск с фильтрами отдаёт свежие данные.
   * Из-за этого справочник товаров был неполным, и наша карточка товара
   * отвечала «товар не найден» на всё, чего в застрявшем списке нет
   * (замечание Александра 09.08).
   */
  let brandQuery = '';
  try {
    const fr = await fetch(base + '&c=' + Date.now() + '&getallparts=true&size=1');
    const fj = await fr.json();
    const bf = ((fj && fj.filters && fj.filters.filters) || []).filter(g => g.name === 'brand')[0];
    const names = ((bf && bf.values) || []).map(v => String(v.value || '')).filter(Boolean);
    names.forEach((n, i) => { brandQuery += '&filters%5Bbrand%5D%5B' + i + '%5D=' + encodeURIComponent(n); });
  } catch (e) { console.log('список брендов:', e.message); }

  const items = [];
  const seenUid = {};
  for (let slice = 1; slice <= 10; slice++) {
    const r = await fetch(base + brandQuery + '&slice=' + slice + '&size=300&c=' + Date.now());
    const j = await r.json().catch(() => null);
    const list = (j && j.products) || [];
    list.forEach(p => { const k = String(p.uid || p.sku || ''); if (k && !seenUid[k]) { seenUid[k] = 1; items.push(p); } });
    if (list.length < 300) break;
  }
  // Если перечисление брендов почему-то не сработало, берём как раньше —
  // неполный каталог лучше пустого.
  if (items.length < 300 && brandQuery) {
    for (let slice = 1; slice <= 10; slice++) {
      const r = await fetch(base + '&slice=' + slice + '&size=300&c=' + Date.now());
      const j = await r.json().catch(() => null);
      const list = (j && j.products) || [];
      list.forEach(p => { const k = String(p.uid || p.sku || ''); if (k && !seenUid[k]) { seenUid[k] = 1; items.push(p); } });
      if (list.length < 300) break;
    }
  }

  const stockRaw = await env.ORDERS.get('catalog:stock');
  const stock = stockRaw ? JSON.parse(stockRaw) : { stock: {}, sku: {} };
  const revRaw = await env.ORDERS.get('catalog:reviews');
  const rev = revRaw ? JSON.parse(revRaw) : { items: {} };

  const cards = [];
  const seen = {};
  items.forEach(p => {
    const art = String(p.sku || '').trim();
    if (!art || seen[art]) return;
    // На полке только то, что действительно можно купить: правило витрины —
    // от 4 штук (остаток берём живой, из Ozon).
    const left = Number((stock.stock || {})[art] || 0);
    if (left < 4) return;
    seen[art] = 1;
    // Tilda отдаёт цену как «776.0000», а старую — как «961,00», через
    // запятую. Из-за неё число не читалось и полка скидок выходила пустой.
    const money = v => Number(String(v == null ? '' : v).replace(',', '.')) || 0;
    const price = money(p.price);
    const old = money(p.priceold);
    if (!price) return;
    const ozonSku = (stock.sku || {})[art];
    const r = ozonSku ? (rev.items || {})[ozonSku] : null;
    cards.push({
      art: art,
      title: String(p.title || ''),
      url: String(p.url || ''),
      img: String((p.gallery && JSON.parse(p.gallery || '[]')[0] || {}).img || ''),
      price: price,
      old: old > price ? old : 0,
      off: old > price ? Math.round((old - price) / old * 100) : 0,
      n: r ? r.n : 0,
      avg: r && r.n ? Math.round((r.s / r.n) * 10) / 10 : 0
    });
  });

  // Заодно складываем справочник каталога по артикулам: из него собирается
  // наша собственная карточка товара, чтобы не зависеть от того, отрисовала
  // ли Tilda нужный товар в каталоге (решение Александра 08.08).
  const index = {};
  // Описания храним отдельно, разложив по последней цифре артикула: вместе
  // с указателем они давали несколько мегабайт, и запись не проходила.
  const texts = {};
  items.forEach(p => {
    const art = String(p.sku || '').trim();
    if (!art || index[art]) return;
    let gallery = [];
    try { gallery = JSON.parse(p.gallery || '[]').map(g => String(g.img || '')).filter(Boolean); } catch (e) {}
    const bucket = art.slice(-1);
    (texts[bucket] || (texts[bucket] = {}))[art] = String(p.text || '').slice(0, 4000);
    index[art] = {
      t: String(p.title || ''),
      p: Number(String(p.price || '').replace(',', '.')) || 0,
      o: Number(String(p.priceold || '').replace(',', '.')) || 0,
      g: gallery.slice(0, 8),
      uid: String(p.uid || ''),
      url: String(p.url || ''),
      unit: String(p.unit || 'шт.'),
      portion: String(p.portion || '1'),
      pk: [p.pack_label || '', p.pack_x || '', p.pack_y || '', p.pack_z || '', p.pack_m || ''].join('|')
    };
  });
  await env.ORDERS.put('catalog:index', JSON.stringify({ updated: new Date().toISOString(), items: index }));

  /*
   * Какие значения фильтров вообще имеет смысл предлагать.
   *
   * Tilda считает по всему каталогу: у California Gold Nutrition она пишет
   * 81 товар, хотя на складе нет ни одного. Покупатель выбирал бренд
   * и попадал на пустую витрину (замечание Александра 08.08). Считаем сами
   * и только по тому, что действительно есть в наличии.
   */
  const facets = {};
  try {
    const fr = await fetch('https://store.tildaapi.com/api/getfilters/?storepartuid=' + part + '&recid=' + rec + '&c=' + Date.now());
    const fj = await fr.json();
    const groups = (fj && fj.filters) || [];
    // Разделы приходят числовыми ключами — переводим их в названия.
    const sections = {};
    groups.forEach(g => {
      if (g.name !== 'storepartuid') return;
      (g.values || []).forEach(v => { sections[String(v.id)] = String(v.value || ''); });
    });
    const labelOf = {};
    groups.forEach(g => { if (g.name) labelOf[g.name] = String(g.label || g.name); });

    const bump = (group, value) => {
      if (!group || !value) return;
      const box = facets[group] || (facets[group] = {});
      box[value] = (box[value] || 0) + 1;
    };
    items.forEach(p => {
      const art = String(p.sku || '').trim();
      if (!art || !seen[art]) return;          // seen — только то, что в наличии
      if (p.brand) bump(labelOf.brand || 'Бренд', String(p.brand));
      let parts = [];
      try { parts = JSON.parse(p.partuids || '[]'); } catch (e) {}
      parts.forEach(id => bump(labelOf.storepartuid || 'Раздел', sections[String(id)]));
      (p.characteristics || []).forEach(c => {
        const title = String(c.title || '');
        const value = String(c.value || '');
        // Состав и способ применения — не фильтры, а простыни текста.
        if (!title || !value || value.length > 60) return;
        bump(title, value);
      });
    });
  } catch (e) { console.log('значения фильтров:', e.message); }
  await env.ORDERS.put('catalog:facets', JSON.stringify({ updated: new Date().toISOString(), groups: facets }));
  for (const b of Object.keys(texts)) {
    await env.ORDERS.put('catalog:text:' + b, JSON.stringify(texts[b]));
  }

  const byReviews = cards.filter(c => c.n > 0).sort((a, b) => b.n - a.n).slice(0, SHELF_SIZE);
  const byDiscount = cards.filter(c => c.off > 0).sort((a, b) => b.off - a.off).slice(0, SHELF_SIZE);
  const snap = { updated: new Date().toISOString(), total: cards.length, byReviews, byDiscount };
  await env.ORDERS.put('catalog:shelves', JSON.stringify(snap));
  return { updated: snap.updated, вНаличии: cards.length, отзывы: byReviews.length, скидки: byDiscount.length };
}

async function refreshShelvesIfStale(env) {
  const raw = await env.ORDERS.get('catalog:shelves');
  if (raw) {
    const age = Date.now() - Date.parse(JSON.parse(raw).updated || 0);
    if (age < 60 * 60 * 1000) return;
  }
  await refreshShelves(env).catch(e => console.log('обновление полок:', e.message));
}

/**
 * Отзывы покупателей с Ozon.
 *
 * Их почти 30 тысяч — за один заход не выгрузить, да и незачем: берём
 * по полторы тысячи за раз и складываем в копилку. Полный круг проходит
 * примерно за полчаса, дальше начинается заново, чтобы подхватывать свежие.
 *
 * Храним по каждому товару: сколько отзывов, сумму оценок (из неё считается
 * средняя) и до восьми текстов — оценок много, а текст есть примерно
 * у каждого пятого, поэтому тексты копим отдельно.
 */
const REVIEW_PAGES_PER_RUN = 15;
const REVIEW_TEXTS_PER_SKU = 20;

async function refreshReviews(env) {
  const token = await sellerToken(env);
  const raw = await env.ORDERS.get('catalog:reviews');
  const st = raw ? JSON.parse(raw) : { items: {}, last_id: '', pass: 0, seen: 0 };
  const items = st.items || {};
  let lastId = st.last_id || '';
  let got = 0;
  let finished = false;

  for (let page = 0; page < REVIEW_PAGES_PER_RUN; page++) {
    const body = { limit: 100, sort_dir: 'DESC', status: 'ALL' };
    if (lastId) body.last_id = lastId;
    const r = await sellerCall(env, token, '/v1/review/list', body);
    const list = (r && r.reviews) || [];
    if (!list.length) { finished = true; break; }
    list.forEach(rev => {
      const sku = String(rev.sku || '');
      if (!sku) return;
      const it = items[sku] || (items[sku] = { n: 0, s: 0, t: [], ids: [] });
      // Один и тот же отзыв не считаем дважды при повторном круге.
      if (it.ids.indexOf(rev.id) > -1) return;
      it.ids.push(rev.id);
      if (it.ids.length > 400) it.ids.shift();
      it.n++;
      it.s += Number(rev.rating) || 0;
      const text = String(rev.text || '').trim();
      if (text && it.t.length < REVIEW_TEXTS_PER_SKU) {
        it.t.push({
          id: rev.id,
          r: Number(rev.rating) || 0,
          x: text.slice(0, 600),
          d: String(rev.published_at || '').slice(0, 10),
          // Имён Ozon не отдаёт ни одним методом. Вместо выдуманного имени —
          // то, что можно подтвердить: покупка доставлена и есть ли фото.
          v: rev.order_status === 'DELIVERED' ? 1 : 0,
          p: Number(rev.photos_amount) || 0
        });
      }
    });
    got += list.length;
    lastId = (r && r.last_id) || '';
    if (!(r && r.has_next) || !lastId) { finished = true; break; }
  }

  st.items = items;
  st.last_id = finished ? '' : lastId;
  st.seen = (st.seen || 0) + got;
  if (finished) { st.pass = (st.pass || 0) + 1; st.seen = 0; }
  st.updated = new Date().toISOString();
  await env.ORDERS.put('catalog:reviews', JSON.stringify(st));
  return { updated: st.updated, товаров: Object.keys(items).length, заПроход: got, кругЗавершён: finished };
}

async function refreshReviewsIfStale(env) {
  const raw = await env.ORDERS.get('catalog:reviews');
  if (raw) {
    const s = JSON.parse(raw);
    const age = Date.now() - Date.parse(s.updated || 0);
    // Круг не пройден — идём дальше через 2 минуты; пройден — ждём сутки.
    if (age < (s.last_id ? 2 : 24 * 60) * 60 * 1000) return;
  }
  await refreshReviews(env).catch(e => console.log('обновление отзывов:', e.message));
}

async function refreshStockIfStale(env) {
  const raw = await env.ORDERS.get('catalog:stock');
  if (raw) {
    const age = Date.now() - Date.parse(JSON.parse(raw).updated || 0);
    if (age < 20 * 60 * 1000) return;
  }
  await refreshStock(env).catch(e => console.log('обновление остатков:', e.message));
}

async function refreshAvailabilityIfStale(env) {
  const raw = await env.ORDERS.get('catalog:unavailable');
  if (raw) {
    const age = Date.now() - Date.parse(JSON.parse(raw).updated || 0);
    if (age < 6 * 3600 * 1000) return;
  }
  await refreshAvailability(env).catch(e => console.log('обновление каталога:', e.message));
}

async function pollPayments(env) {
  const list = await env.ORDERS.list({ prefix: 'order:' });
  // Дневник опроса: без него не видно, почему заказ не поехал в доставку.
  const diary = { at: new Date().toISOString(), checked: 0, paid: 0, notes: [] };
  for (const k of list.keys) {
    const raw = await env.ORDERS.get(k.name);
    if (!raw) continue;
    const order = JSON.parse(raw);
    if (order.status !== 'awaiting_payment') continue;
    // Заказы старше двух суток не опрашиваем — покупатель не вернётся.
    if (Date.now() - Date.parse(order.received_at) > 48 * 3600 * 1000) continue;

    diary.checked++;
    for (const candidate of paymentIdCandidates(order)) {
      const st = await payStatus(env, candidate);
      if (!st) continue;
      order.pay_ext_id = candidate;
      await env.ORDERS.put(k.name, JSON.stringify(order));
      diary.notes.push(k.name + ' -> ' + st);
      if (/PAID|COMPLETED|SUCCESS/i.test(st)) {
        diary.paid++;
        console.log('оплата найдена опросом:', k.name, candidate, st);
        await createDelivery(env, order.ext_id || candidate, order);
      }
      break;
    }
  }
  diary.notes = diary.notes.slice(0, 20);
  await env.ORDERS.put('poll:last', JSON.stringify(diary), { expirationTtl: 86400 });
}

/**
 * Номер заказа в Ozon Pay: Tilda склеивает «проект:заказ», например
 * 27635446:1649104691 (подсмотрено в кабинете эквайринга). Основной вариант
 * ставим первым, остальные оставляем на случай смены формата.
 */
const TILDA_PROJECT = '27635446';

function paymentIdCandidates(order) {
  if (order.pay_ext_id) return [order.pay_ext_id];
  const out = [];
  if (order.ext_id) out.push(TILDA_PROJECT + ':' + order.ext_id);
  if (order.payment_id) out.push(TILDA_PROJECT + ':' + order.payment_id);
  if (order.ext_id) out.push(String(order.ext_id));
  if (order.payment_id) out.push(String(order.payment_id));
  if (order.tranid) out.push(String(order.tranid));
  return out;
}

/** Статус заказа в Ozon Pay: подпись sha256(extId + accessKey + secretKey). */
async function payStatus(env, extId) {
  if (!env.OZONPAY_ACCESS_KEY) return null;
  const sign = await sha256hex(extId + env.OZONPAY_ACCESS_KEY + env.OZONPAY_SECRET_KEY);
  const r = await fetch(PAYAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ accessKey: env.OZONPAY_ACCESS_KEY, extId, requestSign: sign })
  });
  if (r.status === 404) return null;              // такого заказа в Ozon Pay нет
  if (!r.ok) return null;                         // 502 и прочие сбои — просто ждём следующего опроса
  const j = await r.json().catch(() => null);
  if (!j) return null;
  return String(j.status || (j.order && j.order.status) || '');
}

/**
 * Личные настройки покупателя на стороне интегратора.
 *
 * Раньше псевдоним и аватар жили только в памяти браузера: сменил
 * устройство или почистил кэш — и выбор пропал (замечание Александра 08.08).
 * Теперь они хранятся у нас и приезжают на любое устройство.
 *
 * Чем опознаём покупателя. Проверить токен Tilda на стороне сервера нельзя:
 * он привязан к браузеру и адресу, и метод профиля отвечает отказом. Поэтому
 * ключом служит почта, которой покупатель вошёл, — не открытым текстом,
 * а её отпечатком. В настройках нет ничего чувствительного: имя, которое
 * покупатель сам выбрал для показа, и номер картинки. Заказы, оплата
 * и документы этим ключом не управляются.
 */
async function profileKey(login, env) {
    const s = String(login || '').trim().toLowerCase();
    if (!s || s.indexOf('@') < 0) return '';
    const salt = env.ADMIN_TOKEN || 'ngr';
    const buf = new TextEncoder().encode(salt + '|' + s);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return 'profile:' + [...new Uint8Array(hash)].slice(0, 12)
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function profileGet(request, env) {
    const url = new URL(request.url);
    const key = await profileKey(url.searchParams.get('login'), env);
    if (!key) return json({ error: 'нужна почта' }, 400);
    const raw = await env.ORDERS.get(key);
    return json(raw ? JSON.parse(raw) : {});
}

async function profileSet(request, env) {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'нет данных' }, 400);
    const key = await profileKey(body.login, env);
    if (!key) return json({ error: 'нужна почта' }, 400);
    // Кладём только то, что знаем: длинный псевдоним и посторонние поля
    // в хранилище не попадают.
    const value = {
        nick: String(body.nick || '').slice(0, 24),
        avatar: /^nutrygo-\d{1,3}$/.test(String(body.avatar || '')) ? String(body.avatar) : '',
        updated: new Date().toISOString()
    };
    await env.ORDERS.put(key, JSON.stringify(value));
    return json({ ok: true, saved: value });
}

/**
 * Поиск товара для страницы документов: по названию, бренду или артикулу,
 * сразу с номером свидетельства о госрегистрации. Раньше на странице было
 * только поле ввода — искать оно ничего не умело (замечание Александра
 * 08.08).
 */
async function catalogSearch(request, env) {
    const url = new URL(request.url);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return json({ items: [] });
    const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 60);

    const idxRaw = await env.ORDERS.get('catalog:index');
    if (!idxRaw) return json({ items: [], building: true });
    const items = JSON.parse(idxRaw).items || {};
    const sgrRaw = await env.ORDERS.get('catalog:sgr');
    const sgr = sgrRaw ? (JSON.parse(sgrRaw).sgr || {}) : {};

    const out = [];
    for (const art of Object.keys(items)) {
        const it = items[art];
        const title = String(it.t || '');
        if (art.toLowerCase().indexOf(q) < 0 && title.toLowerCase().indexOf(q) < 0) continue;
        out.push({ art, title, url: it.url || '', sgr: sgr[art] || '' });
        if (out.length >= limit) break;
    }
    // Совпадение с начала названия важнее совпадения в середине.
    out.sort((a, b) => {
        const A = a.title.toLowerCase().indexOf(q), B = b.title.toLowerCase().indexOf(q);
        return (A < 0 ? 999 : A) - (B < 0 ? 999 : B);
    });
    return json({ items: out, total: out.length });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function script(code) {
  return new Response(code, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // Короткий кэш: правки вёрстки должны доезжать до покупателей за минуту,
      // а не через пять — при этом повторные заходы всё равно берут из кэша.
      'Cache-Control': 'public, max-age=60',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/** Запросы приходят со страницы личного кабинета nutry-go.ru. */
function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(resp.body, { status: resp.status, headers: h });
}

/* ---------- Сроки доставки для карточки товара и корзины ---------- */

/**
 * Возвращает срок доставки в выбранный пункт: спрашиваем у Ozon чекаут
 * и берём ближайший интервал. Ответ кэшируем на час — покупатели ходят
 * по одним и тем же пунктам, а лимиты API беречь надо.
 */
async function deliveryEta(request, env) {
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
  const pointId = Number(body.point_id || 0);
  const items = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
  if (!pointId || !items.length) return json({ error: 'need point_id and items' }, 400);

  const cacheKey = 'eta:' + pointId + ':' + items.map(i => (i.sku || i.offer_id) + 'x' + (i.quantity || 1)).join(',');
  const cached = await env.ORDERS.get(cacheKey);
  if (cached) return json(JSON.parse(cached));

  const token = await sellerToken(env);
  const payload = {
    delivery_schema: 'FBS',
    delivery_type: { pick_up: { map_point_id: pointId } },
    items: items.map(i => (i.sku ? { sku: Number(i.sku), quantity: Number(i.quantity) || 1 }
                                 : { offer_id: String(i.offer_id), quantity: Number(i.quantity) || 1 }))
  };
  if (body.phone) payload.buyer_phone = String(body.phone).replace(/\D/g, '');

  const r = await sellerCall(env, token, '/v2/delivery/checkout', payload);
  const dates = [];
  // Ozon отказывается везти товар, снятый с продажи в кабинете (BANNED).
  // Раньше это выяснялось уже после оплаты: покупатель платил, а отправление
  // не создавалось. Теперь причина возвращается в корзину — до кассы.
  const blocked = [];
  (r && r.splits || []).forEach(s => {
    const reason = String(s.unavailable_reason || '');
    if (reason && reason !== 'UNSPECIFIED') {
      (s.items || []).forEach(it => blocked.push({
        offer_id: String(it.offer_id || ''), sku: it.sku || 0, reason
      }));
      return;
    }
    const slots = (s.delivery_method && s.delivery_method.timeslots) || [];
    slots.slice(0, 1).forEach(t => {
      const from = t.client_date_range && t.client_date_range.from || t.logistic_date_range && t.logistic_date_range.from;
      const to = t.client_date_range && t.client_date_range.to || t.logistic_date_range && t.logistic_date_range.to;
      if (from) dates.push({ from, to });
    });
  });

  const res = blocked.length
    ? { ok: false, blocked, reason: blocked[0].reason }
    : dates.length
      ? { ok: true, splits: (r.splits || []).length, from: dates[0].from, to: dates[0].to }
      : { ok: false, reason: (r && r.message) || 'нет данных' };
  // Кэшируем только удачные ответы: иначе разовый сбой (например, протухший
  // токен) залипает на час и покупатель видит «срок уточним» без причины.
  if (res.ok) await env.ORDERS.put(cacheKey, JSON.stringify(res), { expirationTtl: 3600 });
  return json(res);
}

/* ---------- Отмена и изменение заказа покупателем ---------- */

/**
 * Покупатель нажимает в личном кабинете «Отменить заказ» или «Изменить данные».
 * Ozon отправляет таких покупателей «на сайт партнёра» — значит, обработать
 * должны мы. Отмену пробуем провести в Ozon сразу; возврат денег и правки
 * данных подтверждает менеджер — деньги и состав заказа без человека не трогаем.
 */
async function orderRequest(request, env, ctx) {
  let body = {};
  try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }

  const kind = body.kind === 'change' ? 'change' : 'cancel';
  const extId = String(body.ext_id || body.order || '').trim();
  const phone = String(body.phone || '').replace(/\D/g, '');
  const text = String(body.text || '').slice(0, 500);
  if (!extId) return json({ error: 'no order' }, 400);

  const raw = await env.ORDERS.get('order:' + extId);
  const order = raw ? JSON.parse(raw) : null;

  // Телефон запроса должен совпасть с телефоном заказа — только тогда
  // отмена уходит в Ozon автоматически. Пустой телефон больше не проходит:
  // раньше отсутствие телефона отключало проверку целиком (аудит NG-P0-02).
  const orderPhone = order ? String(order.phone || '').replace(/\D/g, '').slice(-10) : '';
  const reqPhone = phone.slice(-10);
  const phoneOk = !!(orderPhone && reqPhone && orderPhone === reqPhone);

  let ozonResult = null;
  if (kind === 'cancel' && order && order.ozon_order && phoneOk) {
    ozonResult = await tryCancelOzon(env, order);
  }

  if (order) {
    order.status = kind === 'cancel' ? 'cancel_requested' : 'change_requested';
    order.request_text = text;
    order.request_at = new Date().toISOString();
    if (ozonResult) order.cancel_result = ozonResult;
    await env.ORDERS.put('order:' + extId, JSON.stringify(order));
  }

  const who = order ? (order.name + ', ' + order.phone) : ('телефон ' + phone);
  const head = kind === 'cancel' ? 'ОТМЕНА заказа' : 'ИЗМЕНЕНИЕ заказа';
  await notify(env,
    head + ' ' + extId + '\n' + who +
    (text ? '\nСообщение покупателя: ' + text : '') +
    (kind === 'cancel' && !phoneOk
      ? '\n⚠ Телефон заявителя не совпал с заказом — проверьте вручную, отправление НЕ отменялось автоматически.'
      : '') +
    (ozonResult ? '\nOzon: ' + ozonResult
      : (order && order.ozon_order ? '' : '\nОтправление в Ozon ещё не создано — отменять нечего.')) +
    (kind === 'cancel' ? '\nВерните оплату в кабинете Ozon Pay.' : ''));

  return json({
    ok: true,
    kind,
    ozon: ozonResult,
    message: kind === 'cancel'
      ? 'Заявка на отмену принята. Мы отменим заказ и вернём оплату в течение рабочего дня.'
      : 'Заявка на изменение принята. Менеджер свяжется с вами для подтверждения.'
  });
}

/** Отмена отправления в Ozon: причину берём из динамического списка. */
async function tryCancelOzon(env, order) {
  try {
    const token = await sellerToken(env);
    const orderNumber = order.ozon_order && (order.ozon_order.order_number || order.ozon_order.number);
    const orderId = order.ozon_order && (order.ozon_order.order_id || order.ozon_order.id);
    if (!orderId && !orderNumber) return 'номер заказа Ozon неизвестен';

    const can = await sellerCall(env, token, '/v1/order/cancel/check', { order_id: orderId });
    if (can && can.is_available === false) return 'Ozon отменить не даёт (заказ уже в доставке)';

    const reasons = await sellerCall(env, token, '/v1/cancel-reason/list-by-order', { order_id: orderId });
    const list = (reasons && (reasons.reasons || reasons.result)) || [];
    const reason = list.find(r => /покупател/i.test(r.title || r.name || '')) || list[0];
    if (!reason) return 'нет доступных причин отмены';

    const res = await sellerCall(env, token, '/v1/order/cancel', {
      order_id: orderId, cancel_reason_id: reason.id || reason.cancel_reason_id
    });
    return res && !res.code ? 'отправление отменено' : ('отказ Ozon: ' + JSON.stringify(res).slice(0, 150));
  } catch (e) {
    return 'сбой отмены: ' + e.message;
  }
}

/* ---------- 1. Приём заказа из Tilda ---------- */

/**
 * Превращает плоские поля со скобками во вложенную структуру:
 *   payment[products][0][sku] -> payment.products[0].sku
 * Именно так Tilda отправляет заказ в вебхук.
 */
function expandBrackets(flat) {
  const out = {};
  for (const key of Object.keys(flat)) {
    const m = key.match(/^([^\[]+)((\[[^\]]*\])*)$/);
    if (!m || !m[2]) { out[key] = flat[key]; continue; }
    const path = [m[1], ...m[2].slice(1, -1).split('][')];
    let node = out;
    for (let i = 0; i < path.length; i++) {
      const part = path[i];
      const last = i === path.length - 1;
      if (last) { node[part] = flat[key]; break; }
      const nextIsIndex = /^\d+$/.test(path[i + 1]);
      if (node[part] === undefined || typeof node[part] !== 'object') node[part] = nextIsIndex ? [] : {};
      node = node[part];
    }
  }
  return out;
}

/**
 * Приём заказа из корзины сайта.
 *
 * Адрес этого обработчика виден в коде страницы, поэтому подделать запрос
 * снаружи технически несложно: чужой «заказ» осел бы в базе и увёл менеджера
 * в несуществующую отгрузку. Ограничиваем приём тремя проверками:
 *   • запрос пришёл со страниц нашего магазина (Origin/Referer);
 *   • в нём есть номер заказа и телефон — у подделок их обычно нет;
 *   • подозрительные обращения записываем в журнал и молчим в ответ,
 *     чтобы не подсказывать отправителю, что именно не подошло.
 * Проверка оплаты остаётся главным рубежом: отправление создаётся только
 * после подтверждения от Ozon Pay, поэтому подделка заказа деньгами не грозит.
 */
function looksLikeOurSite(request) {
  const src = (request.headers.get('Origin') || request.headers.get('Referer') || '').toLowerCase();
  if (!src) return true;                       // Tilda шлёт заказ без Origin — не отвергаем
  return /(^|\/\/|\.)nutry-go\.ru/.test(src) || src.includes('tilda');
}

/**
 * Подтверждение входа покупателя.
 *
 * Сайт кладёт в заказ токен личного кабинета Tilda. Верить ему на слово
 * нельзя — поле подделывается, — поэтому спрашиваем саму Tilda, чей это
 * токен. На выдуманный токен она отвечает «unauthorized», проверено.
 *
 * Если Tilda не ответила (её сбой, сеть), заказ пропускаем: терять оплаченный
 * заказ из-за чужой недоступности хуже, чем пропустить одного гостя.
 */
async function verifyMember(env, token, force) {
  // Аварийный выключатель. Если Tilda вдруг перестанет передавать поле,
  // отвалятся все заказы разом — тогда проверку гасим одной записью в базе
  // (require_member = no), без выкладки новой версии.
  //
  // Для личного кабинета выключатель не действует (force): там мы не
  // пропускаем заказ, а решаем, чьи заказы показать, — тут проверка нужна
  // всегда.
  if (!force) {
    const flag = await env.ORDERS.get('require_member');
    if (flag === 'no') return { ok: true, login: '', disabled: true };
  }
  if (!token || token.length < 16) return { ok: false, why: 'токен не передан' };
  try {
    const r = await fetch('https://members.tildaapi.com/api/getprofile/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ projectid: env.TILDA_PROJECT_ID || '27635446', token: token })
    });
    const j = await r.json().catch(() => null);
    if (j && j.status === 'ok' && j.data) {
      return {
        ok: true,
        login: String(j.data.login || j.data.email || ''),
        phone: String(j.data.phone || '').replace(/\D/g, ''),
        name: String(j.data.name || '')
      };
    }
    return { ok: false, why: 'Tilda не признала токен' };
  } catch (e) {
    console.log('проверка входа недоступна, пропускаем заказ:', e.message);
    return { ok: true, login: '', degraded: true };
  }
}

async function tildaOrder(request, env, ctx) {
  if (!looksLikeOurSite(request)) {
    ctx.waitUntil(env.ORDERS.put('reject:' + Date.now(), JSON.stringify({
      at: new Date().toISOString(),
      from: request.headers.get('Origin') || request.headers.get('Referer') || '',
      ip: request.headers.get('CF-Connecting-IP') || ''
    }), { expirationTtl: 86400 * 14 }));
    return json({ status: 'OK' });
  }

  const ct = request.headers.get('Content-Type') || '';
  let data = {};
  if (ct.includes('json')) data = await request.json();
  else data = Object.fromEntries((await request.formData()).entries());

  // Tilda шлёт номер заказа в paymentsystem-полях либо orderid
  // Tilda присылает заказ плоскими полями со скобками:
  //   payment[orderid]=…, payment[products][0][sku]=…
  // Собираем из них нормальную структуру, иначе номер заказа и состав пустые.
  data = expandBrackets(data);

  let pay = data.payment;
  if (typeof pay === 'string') { try { pay = JSON.parse(pay); } catch (e) { pay = null; } }
  if (!pay || typeof pay !== 'object') pay = {};

  const extId = String(
    data.paymentid || data.orderid || data.tranid ||
    pay.orderid || pay.systranid || pay.sys_order_id || ''
  ).trim();
  const phone = String(data.Phone || data.phone || '').replace(/\D/g, '');
  const address = String(data.address || '');
  const pointMatch = address.match(/пункт\s*№\s*(\d+)/i);

  // Заказ принимаем только от зарегистрированного покупателя (решение
  // Александра 07.08). Проверку на сайте обойти несложно, поэтому токен
  // личного кабинета подтверждаем у самой Tilda: подделанный она отвергает.
  // Пока проверка выключена, всё равно записываем, дошёл ли токен: по первому
  // же настоящему заказу будет видно, можно ли включать запрет.
  const rawToken = String(data.ngmember || '');
  ctx.waitUntil(env.ORDERS.put('probe:' + Date.now(), JSON.stringify({
    at: new Date().toISOString(),
    ext: extId,
    token_len: rawToken.length,
    fields: Object.keys(data).slice(0, 40)
  }), { expirationTtl: 86400 * 30 }));

  const member = await verifyMember(env, rawToken);
  if (!member.ok) {
    ctx.waitUntil(env.ORDERS.put('reject:' + Date.now(), JSON.stringify({
      at: new Date().toISOString(),
      why: 'нет входа в кабинет: ' + member.why,
      ext: extId,
      email: String(data.Email || ''),
      ip: request.headers.get('CF-Connecting-IP') || ''
    }), { expirationTtl: 86400 * 14 }));
    // Tilda ждёт «OK», иначе будет слать повторы; покупателю причину уже
    // показал сайт, здесь просто не создаём заказ.
    return json({ status: 'OK' });
  }

  // Реферальная программа: покупатель приходит по ссылке ?ref=код, код едет
  // вместе с заказом. Пригласившему начисляем 5 % от суммы ДО скидок
  // (решение Александра 08.08). Списание бонусов — через промокоды Tilda,
  // не больше 30 % заказа и всегда не меньше рубля к оплате.
  const refCode = String(data.ngref || data.ref || '').trim().toLowerCase();

  const order = {
    received_at: new Date().toISOString(),
    member_login: member.login || '',
    ref: refCode,
    ext_id: extId,
    payment_id: String(data.paymentid || data.payment_id || '').trim(),
    tranid: String(data.tranid || '').trim(),
    name: data.Name || '',
    email: data.Email || '',
    phone,
    city: data.city || '',
    delivery_type: data.delivery_type || '',
    address,
    point_id: pointMatch ? Number(pointMatch[1]) : null,
    comment: data.comment || '',
    amount: String(pay.amount || data.amount || ''),
    items: Array.isArray(pay.products) ? pay.products : [],
    // полный набор полей сохраняем, пока обкатываем приём заказов:
    // так видно, что именно прислала Tilda, если чего-то не хватает
    raw: JSON.stringify(data).slice(0, 4000),
    status: 'awaiting_payment'
  };

  // Tilda при подключении шлёт проверочный запрос без данных заказа —
  // на него надо ответить успехом, иначе она не даст подключить приём.
  if (!extId && !phone) {
    console.log('проверочный запрос Tilda:', JSON.stringify(data).slice(0, 200));
    return json({ ok: true, test: true });
  }
  const key = extId || ('phone:' + phone + ':' + Date.now());
  await env.ORDERS.put('order:' + key, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 14 });
  console.log('заказ принят:', key, order.city, order.point_id);

  // Tilda присылает заказ уже после оплаты, поэтому проверяем платёж сразу
  // и создаём отправление, не дожидаясь ближайшего опроса. Опрос остаётся
  // подстраховкой на случай, если это сообщение не дойдёт.
  if (ctx && order.point_id) {
    ctx.waitUntil((async () => {
      for (const candidate of paymentIdCandidates(order)) {
        const st = await payStatus(env, candidate);
        if (!st) continue;
        order.pay_ext_id = candidate;
        await env.ORDERS.put('order:' + key, JSON.stringify(order));
        if (/PAID|COMPLETED|SUCCESS/i.test(st)) {
          console.log('оплата подтверждена сразу:', key, candidate);
          await createDelivery(env, extId || key, order);
        }
        break;
      }
    })());
  }

  // Tilda отправляет форму самим браузером покупателя, поэтому наш ответ
  // он и увидит. Возвращаем не служебный текст, а возврат в магазин —
  // иначе на месте оплаты появляется техническая строка.
  const wantsHtml = (request.headers.get('Accept') || '').includes('text/html');
  if (wantsHtml) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Заказ принят</title>' +
      '<meta http-equiv="refresh" content="0;url=https://nutry-go.ru/">' +
      '<p style="font:16px system-ui;padding:24px">Заказ принят, возвращаем в магазин…</p>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return json({ ok: true });
}

/* ---------- 2. Уведомление об оплате ---------- */

async function paymentWebhook(request, env, ctx) {
  const ct = request.headers.get('Content-Type') || '';
  let n = {};
  try { n = ct.includes('json') ? await request.json() : Object.fromEntries((await request.formData()).entries()); }
  catch (e) { return json({ error: 'bad body' }, 400); }

  const extId = String(n.extId || n.ext_id || '').trim();
  const orderId = String(n.orderId || n.id || '').trim();
  if (!extId && !orderId) return json({ status: 'OK' }); // не наш формат — не падаем

  // Проверяем статус у Ozon Pay сами (подпись hex: id + extId + accessKey + secret)
  const paid = await isPaid(env, orderId, extId);
  console.log('вебхук оплаты:', extId, orderId, 'оплачен=', paid);
  if (!paid) return json({ status: 'OK' });

  const raw = await env.ORDERS.get('order:' + extId);
  if (!raw) {
    console.log('заказ не найден в KV:', extId);
    await notify(env, 'Оплачен заказ ' + extId + ', но данных корзины нет — оформите доставку вручную.');
    return json({ status: 'OK' });
  }
  const order = JSON.parse(raw);
  if (order.status === 'delivery_created') return json({ status: 'OK' }); // повторный вебхук

  ctx.waitUntil(createDelivery(env, extId, order));
  // Бонусы начисляем только по оплаченному заказу — иначе отменённые
  // и неоплаченные корзины раздували бы баланс.
  ctx.waitUntil(creditReferral(env, extId, order));
  return json({ status: 'OK' });
}

async function isPaid(env, orderId, extId) {
  if (!env.OZONPAY_ACCESS_KEY) {
    // Ключа нет — сами подтвердить оплату не можем. По умолчанию НЕ доверяем
    // вебхуку (fail-closed): иначе любой POST на вебхук создаёт отправление
    // (аудит NG-P0-04, 10.08). Аварийный обход — только явным флагом в KV
    // `ozonpay_trust_webhook=yes`, если ключ снят намеренно.
    const trust = await env.ORDERS.get('ozonpay_trust_webhook');
    if (trust === 'yes') return true;
    await notify(env, 'ВНИМАНИЕ: ключ Ozon Pay не задан — оплату подтвердить нечем, ' +
      'заказ НЕ создаётся автоматически. Проверьте OZONPAY_ACCESS_KEY в воркере.');
    return false;
  }
  const src = orderId + extId + env.OZONPAY_ACCESS_KEY + env.OZONPAY_SECRET_KEY;
  const sign = await sha256hex(src);
  const r = await fetch(PAYAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ accessKey: env.OZONPAY_ACCESS_KEY, id: orderId, extId, requestSign: sign })
  });
  if (!r.ok) return false;
  const j = await r.json().catch(() => null);
  const status = j && (j.status || (j.order && j.order.status)) || '';
  return /PAID|COMPLETED|SUCCESS/i.test(String(status));
}

/* ---------- Реферальные бонусы ---------- */

/**
 * Начисление 5 % пригласившему.
 *
 * Правила, согласованные с Александром 08.08:
 *   • считаем от суммы заказа ДО скидок;
 *   • начисляем только по оплаченному заказу;
 *   • сам себе начислить нельзя;
 *   • один заказ учитывается один раз.
 *
 * Баланс держим по коду приглашающего. Код выводится из почты и не
 * раскрывает её — тот же код считает и личный кабинет покупателя.
 */
const REFERRAL_PERCENT = 5;

function referralCode(login) {
  const s = String(login || '').toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 7);
}

async function creditReferral(env, extId, order) {
  try {
    const code = String(order.ref || '').trim().toLowerCase();
    if (!code) return;

    // Сам себе не начисляем.
    const buyerCode = referralCode(order.member_login || order.email || '');
    if (buyerCode === code) return;

    const key = 'bonus:' + code;
    const raw = await env.ORDERS.get(key);
    const acc = raw ? JSON.parse(raw) : { code: code, balance: 0, history: [] };
    if (acc.history.some(h => h.order === extId)) return;   // уже учли

    // Сумма ДО скидок: если Tilda прислала обе, берём большую.
    const paid = Number(order.amount) || 0;
    const full = Math.max(paid, Number(order.amount_before_discount) || 0);
    const add = Math.round(full * REFERRAL_PERCENT / 100);
    if (add <= 0) return;

    acc.balance = (Number(acc.balance) || 0) + add;
    acc.history.unshift({ at: new Date().toISOString(), order: extId, sum: full, add: add });
    if (acc.history.length > 200) acc.history.length = 200;
    await env.ORDERS.put(key, JSON.stringify(acc));
    await notify(env, 'Бонусы: +' + add + ' ₽ по коду ' + code + ' за заказ ' + extId +
      ' (сумма ' + full + ' ₽). Баланс кода: ' + acc.balance + ' ₽.');
  } catch (e) {
    console.log('начисление бонусов:', e.message);
  }
}

/* ---------- 3. Создание доставки ---------- */

async function createDelivery(env, extId, order) {
  // Ход создания пишем по шагам: раньше сбой мог оборваться молча, и было
  // непонятно, на чём именно остановились.
  const trace = [];
  const log = async (step) => {
    trace.push(new Date().toISOString().slice(11, 19) + ' ' + step);
    order.trace = trace;
    await env.ORDERS.put('order:' + extId, JSON.stringify(order));
  };
  try {
    // Перечитываем самое свежее состояние: вызвавший мог передать устаревший
    // объект, а параллельный вызов уже начать или завершить создание.
    const fresh0 = await env.ORDERS.get('order:' + extId);
    const o0 = fresh0 ? JSON.parse(fresh0) : order;
    if (o0.status === 'delivery_created' || o0.ozon_order) {
      console.log('createDelivery: отправление уже создано, пропускаем', extId);
      return;
    }
    if (o0.creating && (Date.now() - Date.parse(o0.creating)) < 180000) {
      console.log('createDelivery: создание уже идёт, пропускаем', extId);
      return;
    }
    // Ставим метку «создаётся» и сразу пишем — параллельный вызов её увидит.
    order.creating = new Date().toISOString();
    await env.ORDERS.put('order:' + extId, JSON.stringify(order));

    await log('старт создания отправления');
    if (!order.point_id) {
      await notify(env, 'Заказ ' + extId + ' оплачен, но пункт выдачи не выбран (' + order.address + ') — оформите вручную.');
      return;
    }
    const token = await sellerToken(env);
    const items = await resolveItems(env, token, order);
    await log('товаров к отправке: ' + items.length + ' (' + items.map(i => i.offer_id || i.sku).join(',') + ')');
    if (!items.length) {
      await notify(env, 'Заказ ' + extId + ': не удалось сопоставить товары — оформите вручную.');
      return;
    }

    const checkout = await sellerCall(env, token, '/v2/delivery/checkout', {
      buyer_phone: order.phone,
      delivery_schema: 'FBS',
      delivery_type: { pick_up: { map_point_id: order.point_id } },
      items
    });
    await log('ответ расчёта: ' + JSON.stringify(checkout).slice(0, 300));
    if (!checkout || !checkout.splits || !checkout.splits.length) {
      await notify(env, 'Заказ ' + extId + ': чекаут доставки не прошёл — оформите вручную. ' + JSON.stringify(checkout).slice(0, 300));
      return;
    }

    if (env.DRY_RUN !== 'no') {
      order.status = 'checkout_ok_dry_run';
      await env.ORDERS.put('order:' + extId, JSON.stringify(order));
      await notify(env, 'Заказ ' + extId + ' оплачен, чекаут доставки прошёл (пункт №' + order.point_id + '). Режим обкатки: создайте отправление вручную.');
      return;
    }

    // Боевое создание отправления. Состав, склад, способ доставки и таймслот
    // берём из ответа чекаута — Ozon требует именно те значения, которые сам
    // и посчитал, иначе заказ не создаётся.
    const splits = [];
    for (const s of checkout.splits) {
      // UNSPECIFIED в этом поле означает «причины нет», а не отказ —
      // настоящие причины приходят отдельными значениями.
      const reason = String(s.unavailable_reason || '');
      if (reason && reason !== 'UNSPECIFIED') {
        // Отмечаем заказ отдельным статусом, иначе опрос оплат будет заходить
        // сюда каждые две минуты и слать менеджеру одно и то же уведомление.
        order.status = 'undeliverable';
        order.undeliverable_reason = reason;
        order.undeliverable_items = (s.items || []).map(i => String(i.offer_id || i.sku || ''));
        await env.ORDERS.put('order:' + extId, JSON.stringify(order));
        await notify(env, 'Заказ ' + extId + ': Ozon не может доставить (' + reason + ', артикулы ' +
          order.undeliverable_items.join(', ') + ') — товар снят с продажи в кабинете. ' +
          'Верните его в продажу и повторите, либо оформите вручную.');
        return;
      }
      const dm = s.delivery_method || {};
      const slot = (dm.timeslots && dm.timeslots[0]) || null;
      if (!slot) {
        await notify(env, 'Заказ ' + extId + ': Ozon не предложил интервалов доставки — оформите вручную.');
        return;
      }
      splits.push({
        warehouse_id: s.warehouse_id,
        delivery_method: {
          delivery_method_id: dm.id,
          delivery_type: dm.delivery_type,
          timeslot_id: slot.timeslot_id,
          logistic_date_range: slot.logistic_date_range,
          price: dm.price
        },
        // Цену Ozon в расчёте не возвращает, но при создании требует — берём
        // ту, по которой покупатель оплатил. Идентификатор передаём ОДИН:
        // при обоих сразу Ozon отвечает «укажите либо sku, либо артикул».
        items: (s.items || []).map(it => {
          const item = {
            quantity: Number(it.quantity) || 1,
            price: { currency_code: 'RUB', units: String(priceFor(order, it)) }
          };
          if (it.sku) item.sku = Number(it.sku);
          else item.offer_id = String(it.offer_id || '');
          return item;
        })
      });
    }

    await log('готовим создание, сплитов: ' + splits.length);
    const person = splitName(order.name);
    const created = await sellerCall(env, token, '/v2/order/create', {
      buyer: { first_name: person.first, last_name: person.last, phone: order.phone },
      recipient: { recipient_first_name: person.first, recipient_last_name: person.last, recipient_phone: order.phone },
      delivery: { pick_up: { map_point_id: order.point_id } },
      delivery_schema: 'FBS',
      splits
    });
    if (!created || created.code) {
      await notify(env, 'Заказ ' + extId + ': Ozon отказал в создании отправления — ' +
        JSON.stringify(created).slice(0, 200) + '. Оформите вручную.');
      order.status = 'create_failed';
      order.create_error = JSON.stringify(created).slice(0, 500);
      await env.ORDERS.put('order:' + extId, JSON.stringify(order));
      return;
    }
    order.status = 'delivery_created';
    order.ozon_order = created;
    delete order.creating;
    await env.ORDERS.put('order:' + extId, JSON.stringify(order));
    await notify(env, 'Заказ ' + extId + ': отправление в Ozon Доставке создано автоматически (пункт №' + order.point_id + ').');
  } catch (e) {
    console.log('createDelivery ошибка:', e.message);
    try { await log('СБОЙ: ' + e.message); } catch (e2) {}
    await notify(env, 'Заказ ' + extId + ': сбой автосоздания доставки (' + e.message + ') — оформите вручную.');
  }
}

/**
 * Товары заказа для Ozon. В корзине Tilda «sku» — это наш артикул, а
 * «externalid» — код товара в Ozon, поэтому артикул отдаём как offer_id.
 */
async function resolveItems(env, token, order) {
  const list = [];
  const products = Array.isArray(order.items) ? order.items : [];
  for (const p of products) {
    const qty = Number(p.quantity || p.amount || 1) || 1;
    const offer = String(p.sku || p.article || '').trim();
    if (offer) list.push({ offer_id: offer, quantity: qty });
  }
  return list;
}

/** Цена позиции за единицу — из состава заказа, по артикулу. */
function priceFor(order, checkoutItem) {
  const offer = String(checkoutItem.offer_id || '');
  const found = (order.items || []).find(p => String(p.sku || p.article || '') === offer);
  const unit = found ? Number(found.price || (Number(found.amount) / Number(found.quantity || 1))) : 0;
  return Math.max(1, Math.round(unit || 0));
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return { first: parts[0] || 'Покупатель', last: parts.slice(1).join(' ') || '-' };
}

/* ---------- Seller API с автообновлением токена ---------- */

/**
 * Токен доступа к Seller API.
 *
 * Две тонкости, на которых уже обожглись:
 * • токен обновления одноразовый — Ozon выдаёт новый при каждом обновлении,
 *   поэтому свежий сразу сохраняем, иначе цепочка рвётся;
 * • сроку из ответа не доверяем: держим токен максимум 45 минут и обновляем
 *   заранее, иначе ловим «token is expired» в самый неподходящий момент.
 */
async function sellerToken(env, force) {
  const cached = force ? null : await env.ORDERS.get('seller_token');
  if (cached) {
    const t = JSON.parse(cached);
    if (Date.now() < t.exp - 60000) return t.access;
  }
  const refresh = (await env.ORDERS.get('seller_refresh')) || env.OZON_REFRESH_TOKEN;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.OZON_APP_CLIENT_ID,
    client_secret: env.OZON_APP_CLIENT_SECRET,
    refresh_token: refresh
  });
  const r = await fetch(XAPI, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = await r.text();
  const p = new URLSearchParams(text);
  const access = p.get('access_token');
  const newRefresh = p.get('refresh_token');
  const ttl = Math.min(Number(p.get('expires_in') || 3600), 2700) * 1000;
  if (!access) throw new Error('не удалось обновить токен: ' + text.slice(0, 120));
  // Новый токен обновления сохраняем ПЕРВЫМ делом: если упасть после выдачи,
  // но до сохранения, старый уже погашен и доступ потерян.
  if (newRefresh) await env.ORDERS.put('seller_refresh', newRefresh);
  await env.ORDERS.put('seller_token', JSON.stringify({ access, exp: Date.now() + ttl }));
  return access;
}

async function sellerCall(env, token, path, payload, retried) {
  const r = await fetch(SELLER + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => null);
  const expired = j && typeof j.message === 'string' && /expired|unauthor|token/i.test(j.message);
  if (expired && !retried) {
    // Токен мог протухнуть между проверкой и запросом — обновляем и повторяем.
    console.log('токен протух, обновляем и повторяем:', path);
    const fresh = await sellerToken(env, true);
    return sellerCall(env, fresh, path, payload, true);
  }
  if (!r.ok) console.log('seller', path, r.status, JSON.stringify(j).slice(0, 200));
  return j;
}

/* ---------- Уведомления менеджеру (Telegram, опционально) ---------- */

async function notify(env, text) {
  console.log('УВЕДОМЛЕНИЕ:', text);
  if (!env.MANAGER_CHAT) return;
  const [tgToken, chatId] = env.MANAGER_CHAT.split(':chat:');
  if (!tgToken || !chatId) return;
  await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: 'NutryGo: ' + text })
  }).catch(() => {});
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
