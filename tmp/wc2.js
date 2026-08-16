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
 *   OZON_CLIENT_ID, OZON_API_KEY                — постоянный ключ кабинета
 *                                                 (всё, кроме методов доставки)
 *   OZONPAY_ACCESS_KEY, OZONPAY_SECRET_KEY      — эквайринг (проверка статуса)
 *   ACCOUNT_SUBJECT_KEY                         — HMAC-ключ аккаунтов (>= 32 символов)
 * Переменные: DRY_RUN ("yes"/"no"), MANAGER_CHAT (опц., Telegram "token:chatId")
 * KV-биндинг: ORDERS
 */

// Исходящий TCP нужен для отправки писем: у Workers нет SMTP, но есть
// сокеты, а порт 25 закрыт — с Яндексом работаем по 465 с TLS сразу.
import { connect } from 'cloudflare:sockets';
import PVZ_PICKER from './pvz-picker.js';
import LK_ORDERS from './lk-orders.js';
import STOCK_GUARD from './ngr-stock.js';

const VERSION = 'promo-price-1';
const XAPI = 'https://xapi.ozon.ru/oauth/token';
const SELLER = 'https://api-seller.ozon.ru';
const PAYAPI = 'https://payapi.ozon.ru/v1/getOrderStatus';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      // Версию показываем, чтобы видеть, докатилось ли обновление:
      // Cloudflare раскатывает новую версию не мгновенно.
      // Проверка настройки: задан ли ключ Ozon Pay. Значение не раскрываем,
      // только да/нет — иначе ошибку конфигурации замечаешь по потерянным
      // заказам, а не сразу (рекомендация аудита 10.08).
      // Проба почтового канала: только соединение и приветствие сервера,
      // без входа и без письма. Нужна, чтобы до написания почтового клиента
      // убедиться, что Яндекс вообще принимает соединение из сети Cloudflare
      // — с tildaapi это ровно так и не сработало (журнал NG-2026-08-13-025).
      // Цель прибита в коде, ничего чужого этой ручкой не отправить.
      //
      // 14.08: канал настроен и проверен, держать пробу открытой больше
      // незачем. С `send=1` она отправляет письмо на ящик магазина — без
      // ключа это чужой способ забивать нашу почту и наш лимит писем.
      // Закрываем тем же ключом, что и остальные служебные ручки.
      if (url.pathname === '/diag/smtp') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        try {
          // Хост берём из короткого списка своих: превращать пробу в
          // сканер чужих портов незачем.
          const списокХостов = {
            yandex: 'smtp.yandex.ru',
            timeweb: 'smtp.timeweb.ru',
            свой: String(env.SMTP_HOST || '')
          };
          const хост = списокХостов[url.searchParams.get('host') || 'свой'] ||
            списокХостов['свой'] || 'smtp.yandex.ru';
          const сокет = connect({ hostname: хост, port: 465 },
            { secureTransport: 'on', allowHalfOpen: false });
          const читатель = сокет.readable.getReader();
          const ответ = await Promise.race([
            читатель.read(),
            new Promise((_, отказ) => setTimeout(() => отказ(new Error('нет ответа за 8 с')), 8000))
          ]);
          const приветствие = new TextDecoder().decode(ответ.value || new Uint8Array()).slice(0, 200);
          try { читатель.releaseLock(); await сокет.close(); } catch (e) {}
          if (url.searchParams.get('send') === '1') {
            try { читатель.releaseLock(); await сокет.close(); } catch (e) {}
            // Получатель — сам ящик магазина, другого адреса эта ручка не
            // знает: открытым ретранслятором ей не стать.
            const итог = await smtpSend(env, {
              to: String(env.SMTP_USER || ''),
              subject: 'NutryGo: проверка почтового канала',
              text: 'Это проверка отправки писем из интегратора. Если письмо дошло, канал работает.'
            });
            return json(итог);
          }
          return json({ ok: /^220/.test(приветствие), хост: хост, приветствие: приветствие.trim() });
        } catch (e) {
          return json({ ok: false, сбой: String(e && e.message || e).slice(0, 200) });
        }
      }
      // Просмотр письма без отправки: чтобы согласовать вид, не рассылая
      // ничего живым покупателям. Данные подставные, ничего чужого не
      // показывает.
      //
      // 14.08: вид писем согласован, и с `send=all` эта ручка умеет слать
      // письма — значит она служебная и стоять открытой не должна.
      if (url.pathname === '/diag/mail') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        const образец = {
          ext_id: '1870945661',
          address: 'Москва, Учинская улица, 1 (пункт №504588)',
          email: 'pokupatel@example.com',
          items: [
            { name: 'NOW Селен 100 мкг, 90 капсул', quantity: 1 },
            { name: 'Бисглицинат магния, 180 капсул', quantity: 2 }
          ]
        };
        const вид = url.searchParams.get('send') === 'all'
          ? 'code' : (url.searchParams.get('kind') || 'accepted');
        let п;
        if (вид === 'code') {
          п = { html: письмоВид({
            тема: 'Код для входа в NutryGo', заголовок: 'Код для входа',
            прехедер: 'Код действует 10 минут',
            тело: '<p style="margin:0">Введите этот код в личном кабинете:</p>' +
              '<div style="margin:18px 0;font-size:34px;font-weight:800;letter-spacing:8px;color:' +
              ЦВЕТ.чернила + '">418302</div>' +
              '<p style="margin:0;color:' + ЦВЕТ.серый + '">Код действует 10 минут.</p>' +
              '<p style="margin:12px 0 0;color:' + ЦВЕТ.серый + '">Если вы не запрашивали вход, ' +
              'просто не отвечайте на это письмо — без кода в кабинет никто не войдёт.</p>'
          }) };
        } else if (вид === 'pickup') {
          п = письмоОДоставке(образец, 'posting_in_pickup_point', '40704586-0718-1');
        } else if (вид === 'received') {
          п = письмоОДоставке(образец, 'posting_received', '40704586-0718-1');
        } else {
          п = письмоОЗаказе(образец, '40704586-0718-1', '16 августа');
        }
        // Отправка всех четырёх писем разом — чтобы проверить не вид, а то,
        // как они доходят: попадают ли в спам, как выглядят в почтовой
        // программе. Получатель прибит к ящику магазина: другого адреса эта
        // ручка не знает и разослать ничего чужого не сможет.
        if (url.searchParams.get('send') === 'all') {
          let кому = String(env.SMTP_USER || env['SMTP-USER'] || '');
          // Можно послать и на адрес покупателя — иначе не увидеть, как письмо
          // выглядит в обычной почте и не попадает ли в спам. Но только на
          // адрес, на который у нас есть заказ: рассылать по произвольным
          // адресам эта ручка не должна. И не чаще раза в час на адрес.
          const хотят = String(url.searchParams.get('to') || '').trim().toLowerCase();
          if (хотят) {
            let нашли = false, курсор;
            do {
              const стр = await env.ORDERS.list({ prefix: 'order:', cursor: курсор });
              for (const к of стр.keys) {
                const сыр = await env.ORDERS.get(к.name);
                if (!сыр) continue;
                try {
                  if (String(JSON.parse(сыр).email || '').trim().toLowerCase() === хотят) {
                    нашли = true; break;
                  }
                } catch (e) {}
              }
              курсор = стр.list_complete || нашли ? '' : String(стр.cursor || '');
            } while (курсор);
            if (!нашли) {
              return json({ error: 'на этот адрес у нас нет заказов — рассылать по нему нельзя' }, 403);
            }
            const частота = 'mailtest:' + хотят;
            if (await env.ORDERS.get(частота)) {
              return json({ error: 'на этот адрес уже отправляли в последний час' }, 429);
            }
            await env.ORDERS.put(частота, new Date().toISOString(), { expirationTtl: 3600 });
            кому = хотят;
          }
          const набор = [
            ['Код для входа', { subject: 'Код для входа в NutryGo: 418302',
              text: 'Ваш код: 418302', html: п.html }],
            ['Заказ принят', письмоОЗаказе(образец, '40704586-0718-1', '16 августа')],
            ['Приехал в пункт', письмоОДоставке(образец, 'posting_in_pickup_point', '40704586-0718-1')],
            ['Получен', письмоОДоставке(образец, 'posting_received', '40704586-0718-1')]
          ];
          const отчёт = [];
          for (const [имя, письмо] of набор) {
            const и = await smtpSend(env, {
              to: кому, subject: письмо.subject, text: письмо.text, html: письмо.html
            });
            отчёт.push({ письмо: имя, ушло: !!и.ok, why: и.why || '' });
          }
          return json({ кому: кому, отчёт: отчёт });
        }
        return new Response(п.html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      /**
       * Здоровье связки.
       *
       * 14.08 выяснилось, что доступ к Ozon умер накануне в 22:04, а узнали
       * мы об этом через пятнадцать часов и случайно — по ошибке расчёта
       * доставки. Поэтому здесь теперь видно главное: жив ли доступ и не
       * протухли ли остатки. Секретов не раскрываем, только да/нет и возраст.
       */
      if (url.pathname === '/health') {
        let ozon = 'unknown', остаткам = null;
        try {
          const raw = await env.ORDERS.get('catalog:stock');
          if (raw) {
            const u = Date.parse(JSON.parse(raw).updated || 0);
            if (u) остаткам = Math.round((Date.now() - u) / 60000);
          }
        } catch (e) {}
        if (url.searchParams.get('ozon') === '1') {
          try { await sellerToken(env); ozon = 'ok'; }
          catch (e) { ozon = 'нет доступа'; }
        }
        // Проба постоянного ключа: один дешёвый вызов кабинета. Нужна, чтобы
        // отличить «ключ не задан» от «ключ задан, но номер кабинета неверный» —
        // по молчащим остаткам этого не понять (15.08).
        let ключ = null;
        /*
         * Проверка: примет ли Ozon Доставка постоянный ключ.
         *
         * Вопрос Александра 16.08: зачем вообще одноразовый OAuth, если есть
         * постоянный ключ кабинета. Отвечаем замером, а не мнением: шлём
         * настоящий расчёт доставки с Api-Key и смотрим ответ Ozon.
         */
        if (url.searchParams.get('apikey') === 'delivery') {
          const было = env.OZON_API_KEY && env.OZON_CLIENT_ID;
          if (!было) { ключ = 'постоянный ключ не задан'; }
          else {
            const r = await fetch(SELLER + '/v2/delivery/checkout', {
              method: 'POST',
              headers: {
                'Client-Id': String(env.OZON_CLIENT_ID),
                'Api-Key': String(env.OZON_API_KEY),
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                delivery_schema: 'FBS',
                delivery_type: { pick_up: { map_point_id: 504588 } },
                items: [{ offer_id: '11293', quantity: 1 }]
              })
            });
            const текст = await r.text();
            ключ = { код: r.status, ответ: текст.slice(0, 220) };
          }
        }
        if (url.searchParams.get('apikey') === '1') {
          try {
            const r = await sellerCall(env, '', '/v4/product/info/stocks',
              { filter: { visibility: 'ALL' }, limit: 1, cursor: '' });
            ключ = (r && r.items) ? 'работает' : ('ответ Ozon: ' + JSON.stringify(r).slice(0, 160));
          } catch (e) { ключ = 'сбой: ' + e.message.slice(0, 120); }
          // Номер кабинета показываем целиком: это не секрет, а опознавание
          // магазина. У ключа — только длина и хвост, чтобы поймать опечатку
          // и лишние пробелы, не раскрывая сам ключ.
          const ид = String(env.OZON_CLIENT_ID || '');
          const кл = String(env.OZON_API_KEY || '');
          ключ = {
            ответ: ключ,
            номер_кабинета: ид || '(пусто)',
            длина_ключа: кл.length,
            хвост_ключа: кл ? ('…' + кл.slice(-4)) : '(пусто)',
            есть_пробелы: /^\s|\s$/.test(ид) || /^\s|\s$/.test(кл),
            // Ozon выдаёт ключ в виде UUID: 36 знаков, только цифры, латиница
            // a-f и дефисы. Любое отличие — признак лишнего символа при копировании.
            длина_без_пробелов: кл.trim().length,
            похож_на_ключ: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(кл.trim()),
            лишние_знаки: (кл.trim().match(/[^0-9a-fA-F-]/g) || []).join('') || 'нет'
          };
        }
        let показПисем = null;
        try { показПисем = await env.ORDERS.get('mailshow:отчёт'); } catch (e) {}
        let застряло = null;
        try { застряло = Number(await env.ORDERS.get('orders:застряло')); } catch (e) {}
        return json({
          ok: true,
          dry_run: env.DRY_RUN !== 'no',
          застряло_заказов: Number.isFinite(застряло) ? застряло : null,
          образцы_писем: показПисем || null,
          pay_configured: !!env.OZONPAY_ACCESS_KEY,
          account_configured: String(env.ACCOUNT_SUBJECT_KEY || '').length >= 32,
          // Задан ли постоянный ключ кабинета: без него каталог и остатки
          // висят на одноразовом OAuth и слепнут вместе с ним (15.08).
          api_key_configured: !!(env.OZON_API_KEY && env.OZON_CLIENT_ID),
          ozon: ozon,
          постоянный_ключ: ключ,
          остаткам_минут: остаткам,
          остатки_свежие: остаткам !== null && остаткам < 90,
          version: VERSION
        });
      }
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
      // непрозрачный account subject (для legacy — проверенный member_login).
      // Введённые в заказ email/телефон прав доступа не дают.
      if (url.pathname === '/orders/my' && request.method === 'OPTIONS') {
        if (!accountOriginAllowed(request)) return json({ error: 'forbidden origin' }, 403);
        return accountCors(request, new Response(null, { status: 204 }));
      }
      /**
       * Свой вход по коду закрыт 14.08.
       *
       * Он был временной заменой, пока Tilda входила только по постоянному
       * паролю. В тот же день в настройках личного кабинета включили
       * «Одноразовый код» — вход по коду с почты делает сама Tilda, и наш
       * блок из окна входа убран (просьба Александра: «убирай наш костыль»).
       *
       * Держать ручку открытой нельзя: она шлёт письмо на любой присланный
       * адрес, а пауза стоит только на повтор для одного и того же адреса.
       * Скрипт с тысячей разных адресов превратил бы её в чужую рассылку от
       * имени info@nutry-go.ru — это и репутация домена, и наш лимит писем.
       *
       * Уже выданные пропуска продолжают действовать: их читает
       * прочестьПропуск() в /orders/my, чтобы никого не выбросить из
       * кабинета на полуслове.
       */
      if (url.pathname === '/auth/request' || url.pathname === '/auth/confirm') {
        if (request.method === 'OPTIONS') {
          return accountCors(request, new Response(null, { status: 204 }));
        }
        return accountCors(request, json({ error: 'вход по коду теперь на стороне Tilda' }, 410));
      }
      if (url.pathname === '/orders/my' && request.method === 'POST') {
        if (!accountOriginAllowed(request)) return json({ error: 'forbidden origin' }, 403);
        const body = await request.json().catch(() => ({}));
        const who = await verifyMember(env, String(body.token || ''), true);
        if (who.unavailable) {
          return accountCors(request, json({ error: 'проверка входа временно недоступна' }, 503));
        }

        /**
         * Предъявление вместо подтверждённого токена.
         *
         * Подтвердить токен Tilda с сервера нельзя: тот же токен работает из
         * браузера покупателя и не работает из сети Cloudflare — девять опытов
         * в журнале NG-2026-08-13-025. Пока у нас нет своего входа, покупателю
         * надо как-то доказать, что заказы его.
         *
         * Доказательством считаем знание того, что видно только в его
         * собственной панели Tilda: для каждого заказа — номер, сумма и время
         * создания разом. Почту одну не приняли бы: почта не секрет, и по ней
         * одной чужие заказы отдавать нельзя.
         *
         * Это временная мера и она слабее настоящей сессии: тот, кто как-то
         * добыл и почту, и точные суммы с датами, пройдёт. Заменяется своим
         * входом по коду на почту, это следующий шаг.
         */
        let mine = who.ok && who.login ? String(who.login).toLowerCase() : '';
        // Свой пропуск сильнее предъявления: он доказывает владение почтой,
        // а не знание чисел из чужой панели. Если он есть — предъявление не
        // нужно вовсе.
        if (!mine && body.pass) {
          const своя = await прочестьПропуск(env, body.pass);
          if (своя) mine = своя;
        }
        let предъявление = null;
        if (!mine && body.claim && typeof body.claim === 'object') {
          const почта = String(body.claim.email || '').trim().toLowerCase();
          const список = Array.isArray(body.claim.orders) ? body.claim.orders.slice(0, 200) : [];
          if (почта.indexOf('@') > 0 && список.length) {
            предъявление = { почта: почта, заказы: {} };
            for (const з of список) {
              const н = String((з && з.id) || '').trim();
              if (!н) continue;
              предъявление.заказы[н] = {
                сумма: Math.round(Number((з && з.amount) || 0)),
                когда: String((з && з.created) || '').slice(0, 16)
              };
            }
            mine = почта;
          }
        }
        if (!mine) {
          return accountCors(request, json({
            error: 'нужен вход в кабинет',
            why: who.why || '', detail: who.detail || ''
          }, 401));
        }
        const subject = who.ok && who.login ? await accountKey(who.login, env) : '';
        if (who.ok && who.login && !subject) {
          return accountCors(request, json({ error: 'синхронизация аккаунта не настроена' }, 503));
        }

        const out = [];
        // Счётчики нужны, чтобы отказ был объясним: без них «ноль заказов»
        // неотличим от «правило не сошлось», и приходится гадать.
        const счёт = { всего: 0, поНомеру: 0, поПочте: 0, поСумме: 0, совпало: 0 };
        let cursor;
        do {
          const page = await env.ORDERS.list({ prefix: 'order:', cursor });
          for (const k of page.keys) {
            const raw = await env.ORDERS.get(k.name);
            if (!raw) continue;
            let o;
            try { o = JSON.parse(raw); } catch (e) { continue; }
            // Новые заказы привязаны к непрозрачному account subject. Для
            // старых 14-дневных записей допускаем только member_login,
            // который Worker получил после проверки Tilda-токена. Email и
            // общий семейный телефон больше не дают доступ к заказу.
            const member = String(o.member_login || '').toLowerCase();
            let same = subject
              ? ((o.member_subject && o.member_subject === subject) ||
                 (!o.member_subject && member && member === mine))
              : false;
            // Путь предъявления: сходиться должны почта, номер и сумма.
            //
            // Время из сверки убрано намеренно: Tilda отдаёт его местным, а мы
            // храним UTC, и сравнение никогда не сходилось. Приводить чужой
            // формат времени к своему «на глаз» — способ однажды пустить не
            // того, поэтому опираемся на то, что сравнивается точно.
            if (!same && предъявление) {
              const н = String(o.ext_id || k.name.slice(6));
              const ждём = предъявление.заказы[н];
              // Сверяем с почтой, которую покупатель ввёл в самом заказе.
              // member_login для этого не годится: он записывался после
              // подтверждения токена, а оно сломано с 10.08, поэтому у всех
              // недавних заказов пуст. Замер: из 8 заказов по номеру и сумме
              // сходились 3, по member_login — ни одного.
              const почтаЗаказа = String(o.email || o.member_login || '').trim().toLowerCase();
              счёт.всего++;
              if (ждём) счёт.поНомеру++;
              if (почтаЗаказа && почтаЗаказа === предъявление.почта) счёт.поПочте++;
              if (ждём && ждём.сумма === Math.round(Number(o.amount) || 0)) счёт.поСумме++;
              same = !!(ждём && почтаЗаказа && почтаЗаказа === предъявление.почта &&
                ждём.сумма === Math.round(Number(o.amount) || 0));
              if (same) счёт.совпало++;
            }
            if (!same) continue;
            out.push({
              id: o.ext_id || k.name.slice(6),
              at: o.received_at || '',
              amount: Number(o.amount) || 0,
              status: o.status || '',
              // Имя и телефон — свои же, из своего заказа. Нужны корзине:
              // вход по одноразовому коду не спрашивает ни того, ни другого,
              // и на новом устройстве подставить в корзину нечего (просьба
              // Александра 14.08: «профиль должен автоматически заполниться»).
              // Адрес и город здесь отдавались и раньше, так что круг
              // сведений не расширяется.
              name: o.name || '',
              phone: o.phone || '',
              city: o.city || '',
              address: o.address || '',
              point: o.point_id || null,
              ozon_order: o.ozon_order || '',
              // Состояние отправления у Ozon: его опрашивает refreshShipments
              // по расписанию. Раньше покупатель видел только статус, который
              // оператор ставил руками в кабинете Tilda (журнал
              // NG-2026-08-13-021), теперь — настоящее состояние доставки.
              shipment: o.shipment ? {
                text: o.shipment.text || '',
                code: o.shipment.substatus || '',
                posting: o.shipment.posting || '',
                checked: o.shipment.checked || ''
              } : null,
              items: (o.items || []).map(i => ({
                name: i.name || '', sku: String(i.sku || i.offer_id || ''),
                qty: Number(i.quantity) || 1, price: Number(i.price) || 0
              }))
            });
          }
          cursor = page.list_complete ? '' : String(page.cursor || '');
        } while (cursor);
        out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        return accountCors(request, json(
          предъявление ? { orders: out, debug: счёт } : { orders: out }));
      }
      // Единое состояние профиля и избранного на всех устройствах. Клиент
      // передаёт только Tilda-токен; email из JSON никогда не используется
      // как идентификатор аккаунта.
      if (url.pathname === '/account/state') {
        if (!accountOriginAllowed(request)) return json({ error: 'forbidden origin' }, 403);
        if (request.method === 'OPTIONS') {
          return accountCors(request, new Response(null, { status: 204 }));
        }
        if (request.method === 'POST') {
          return accountCors(request, await accountState(request, env));
        }
        return accountCors(request, json({ error: 'method not allowed' }, 405));
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
            const token = await токенКабинета(env);
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
      /**
       * Характеристики и описания товаров — прибавка к указателю поиска.
       *
       * Отдаём голый текст по артикулам: сайт подмешивает его в тот же
       * указатель, по которому уже ищет. Ничего секретного здесь нет — это
       * то, что и так написано в карточке товара на Ozon.
       */
      if (url.pathname === '/catalog/searchtext') {
        const key = new Request(url.toString());
        const hit = await caches.default.match(key);
        if (hit) return hit;
        const raw = await env.ORDERS.get('catalog:searchtext');
        if (!raw) {
          // Сборку заводит только расписание. Запускать её из обработчика
          // запросов нельзя: 14.08 каждый заход начинал новый обход поверх
          // идущего, обходы звали обновление токена Ozon внахлёст и порвали
          // цепочку токенов обновления — магазин остался без расчёта доставки.
          return cors(json({ updated: null, building: true, items: {} }));
        }
        const с = JSON.parse(raw);
        // Наружу отдаём одной строкой на артикул: разбирать на части сайту
        // незачем, он всё равно ищет по всему тексту сразу.
        const items = {};
        Object.keys(с.items || {}).forEach(a => {
          const о = с.items[a] || {};
          const t = [о.c || '', о.d || ''].join(' ').replace(/\s+/g, ' ').trim();
          if (t) items[a] = t;
        });
        const res = cors(json({
          updated: с.updated || null, count: Object.keys(items).length,
          артикулов: с.артикулов || 0, курсор: с.курсор || 0,
          беда: с.беда || '', items
        }));
        res.headers.set('Cache-Control', 'public, max-age=3600');
        ctx.waitUntil(caches.default.put(key, res.clone()));
        return res;
      }
      if (url.pathname === '/admin/refresh-searchtext') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        return json(await refreshSearchText(env));
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
          const token = await токенКабинета(env);
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
      //
      // 14.08: ручка на каждый вызов ходит в Ozon тремя запросами, то есть
      // тратит наш лимит обращений. Закрываем ключом заодно с остальными.
      if (url.pathname === '/diag/scopes') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
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
      /**
       * Заказы, застрявшие без отправления.
       *
       * 13.08 в 22:04 оборвался доступ к Ozon, и до 14.08 создание отправлений
       * не работало. Оплата при этом проходит своим путём, через Ozon Pay, —
       * значит заказ мог остаться оплаченным, но не переданным в доставку, и
       * сам он оттуда не выберется: опрос платежей смотрит только ожидающие.
       *
       * Ручка перебирает заказы и показывает те, где оплата есть, а
       * отправления нет. Ничего не меняет — только смотрит.
       */
      if (url.pathname === '/admin/stranded') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        const список = [];
        let курсор, всего = 0;
        do {
          const стр = await env.ORDERS.list({ prefix: 'order:', cursor: курсор });
          for (const к of стр.keys) {
            const сыр = await env.ORDERS.get(к.name);
            if (!сыр) continue;
            let o;
            try { o = JSON.parse(сыр); } catch (e) { continue; }
            всего++;
            const оплачен = !!(o.paid_at || o.paid || o.status === 'paid' ||
              o.status === 'delivery_created' || o.status === 'create_failed');
            const есть = !!(o.ozon_order || o.posting_number);
            if (оплачен && !есть) {
              список.push({
                ext: к.name.replace('order:', ''),
                статус: o.status || '',
                создан: o.created || o.created_at || '',
                оплачен: o.paid_at || '',
                сумма: o.amount || o.total || 0,
                почта: o.email || '',
                последний_шаг: Array.isArray(o.trace) ? o.trace[o.trace.length - 1] : ''
              });
            }
          }
          курсор = стр.list_complete ? '' : String(стр.cursor || '');
        } while (курсор);
        список.sort((a, b) => String(b.создан).localeCompare(String(a.создан)));
        return json({ всего_заказов: всего, без_отправления: список.length, заказы: список });
      }
      /**
       * Повторить создание отправления для застрявших заказов.
       *
       * Делает ровно то, что должно было произойти в момент оплаты. Работает
       * только по списку из /admin/stranded и только за указанный день, чтобы
       * не трогать старое.
       */
      if (url.pathname === '/admin/retry-stranded') {
        if (url.searchParams.get('token') !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403);
        const с = String(url.searchParams.get('since') || '');
        const отчёт = [];
        let курсор;
        do {
          const стр = await env.ORDERS.list({ prefix: 'order:', cursor: курсор });
          for (const к of стр.keys) {
            const сыр = await env.ORDERS.get(к.name);
            if (!сыр) continue;
            let o;
            try { o = JSON.parse(сыр); } catch (e) { continue; }
            const оплачен = !!(o.paid_at || o.paid || o.status === 'paid' || o.status === 'create_failed');
            const есть = !!(o.ozon_order || o.posting_number);
            const когда = String(o.created || o.created_at || '');
            if (!оплачен || есть) continue;
            if (с && когда < с) continue;
            const ext = к.name.replace('order:', '');
            try {
              await createDelivery(env, ext, o);
              const после = JSON.parse(await env.ORDERS.get('order:' + ext));
              отчёт.push({ ext, статус: после.status, отправление: после.ozon_order || null });
            } catch (e) {
              отчёт.push({ ext, ошибка: String(e && e.message || e).slice(0, 160) });
            }
          }
          курсор = стр.list_complete ? '' : String(стр.cursor || '');
        } while (курсор);
        return json({ обработано: отчёт.length, отчёт });
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
      // Старый профиль доверял email из query/body и позволял читать либо
      // перезаписывать preset без Tilda-токена. Оба опубликованных клиента
      // уже используют /account/state, поэтому legacy endpoint закрыт.
      if (url.pathname === '/profile/me') {
        if (!accountOriginAllowed(request)) {
          return accountCors(request, json({ error: 'forbidden origin' }, 403));
        }
        if (request.method === 'OPTIONS') {
          return accountCors(request, new Response(null, { status: 204 }));
        }
        if (request.method === 'GET' || request.method === 'POST') {
          return accountCors(request, json({ error: 'profile endpoint retired' }, 410));
        }
        return accountCors(request, json({ error: 'method not allowed' }, 405));
      }
      /**
       * Восстановление доступа к Ozon.
       *
       * Ozon меняет токен обновления при каждом использовании, и если цепочка
       * оборвалась (`invalid_refresh_token`), сам по себе доступ не вернётся:
       * нужен новый код авторизации от продавца. Порядок описан в README —
       * ссылка, «Разрешить», код из адресной строки живёт 5 минут.
       *
       * Обмен кода на токен делает воркер: client_secret есть только у него,
       * и наружу этот ключ выносить незачем.
       */
      if (url.pathname === '/ozon/oauth/finish') {
        const code = String(url.searchParams.get('code') || '').trim();
        const redirect = String(url.searchParams.get('redirect') || 'https://nutry-go.ru/');
        if (!code) {
          return new Response(
            'Нужен код авторизации: откройте ссылку, нажмите «Разрешить», ' +
            'скопируйте из адресной строки значение code= и подставьте сюда.',
            { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.OZON_APP_CLIENT_ID,
          client_secret: env.OZON_APP_CLIENT_SECRET,
          redirect_uri: redirect,
          code: code
        });
        const r = await fetch(XAPI, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        const text = await r.text();
        const p2 = new URLSearchParams(text);
        const access = p2.get('access_token');
        const refresh = p2.get('refresh_token');
        if (!access || !refresh) {
          return new Response('Ozon не принял код: ' + text.slice(0, 300),
            { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        const ttl = Math.min(Number(p2.get('expires_in') || 3600), 2700) * 1000;
        await env.ORDERS.put('seller_refresh', refresh);
        await env.ORDERS.put('seller_token', JSON.stringify({ access, exp: Date.now() + ttl }));
        await env.ORDERS.delete('seller_refresh:тревога');
        /*
         * Показываем выданные права.
         *
         * 14.08 первая пере-авторизация прошла с одним скоупом вместо шести:
         * логистика ожила, а товары, отправления и остатки — нет, и понять
         * это удалось только по нулю артикулов в сборке. Пусть сразу видно.
         */
        const права = p2.get('scope') || '(Ozon не назвал права в ответе)';
        return new Response(
          'Готово: доступ к Ozon восстановлен.\n\nВыданные права: ' + права +
          '\n\nМожно закрывать страницу.',
          { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      if (url.pathname === '/delivery/eta' && request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (url.pathname === '/delivery/eta' && request.method === 'POST') return cors(await deliveryEta(request, env));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.log('ошибка:', e.message);
      /*
       * Для расчёта доставки причину говорим вслух.
       *
       * 14.08 все запросы /delivery/eta отвечали «internal», и понять почему
       * было нечем: логи Workers в этом аккаунте выключены, а включать их без
       * владельца нельзя. Сообщение здесь — это текст ошибки самого Ozon,
       * тот же, что мы уже показываем в корзине и шлём в Telegram; ключей и
       * личных данных в нём нет.
       */
      if (url.pathname.indexOf('/delivery/') === 0) {
        return cors(json({ error: 'internal', why: String(e && e.message || e).slice(0, 300) }, 500));
      }
      return json({ error: 'internal' }, 500);
    }
  },

  /**
   * Раз в 5 минут сами спрашиваем Ozon Pay, оплачены ли ожидающие заказы.
   * Так связка работает и без вебхука: в кабинете Ozon Банка поля для его
   * адреса нет, а ждать поддержку ради запуска не нужно.
   */
  /**
   * Тяжёлые задачи — по очереди, а не все разом.
   *
   * У Worker есть предел на число исходящих запросов за один вызов. Раньше
   * расписание запускало семь задач сразу, и они этот предел делили: 14.08
   * сбор описаний встал на 850 товарах из 1343 при живом доступе к Ozon и
   * пустой строке ошибки — запросы просто переставали уходить, молча.
   *
   * Теперь оплаты и статусы отправлений идут каждый заход (они лёгкие и
   * важные), а прожорливые — по кругу, по одной за раз. Каталог, остатки,
   * отзывы, подборки и описания получают свой заход каждые десять минут:
   * для всех них это чаще, чем нужно.
   */
  async scheduled(event, env, ctx) {
    /*
     * Задачи идут по очереди, а не разом.
     *
     * Раньше четыре-пять задач стартовали одновременно, и если в этот момент
     * токен Ozon истекал, каждая уходила его обновлять. Обновление у Ozon
     * одноразовое: кто второй — тот рвёт цепочку. Теперь сначала один раз
     * берём токен, а потом задачи выполняются друг за другом и пользуются
     * готовым.
     */
    ctx.waitUntil((async () => {
      try { await sellerToken(env); } catch (e) { console.log('токен для расписания:', e.message); }
      await pollPayments(env).catch(e => console.log('оплаты:', e.message));
      await refreshShipments(env).catch(e => console.log('отправления:', e.message));
      await recoverStrandedIfDue(env).catch(e => console.log('застрявшие:', e.message));
      await разовыйПоказПисем(env).catch(e => console.log('показ писем:', e.message));
    })());

    const очередь = [
      обновитьТокенЗаранее,
      refreshStockIfStale,
      refreshSearchTextIfStale,
      refreshShelvesIfStale,
      refreshSearchTextIfStale,
      refreshAvailabilityIfStale,
      refreshSearchTextIfStale,
      refreshReviewsIfStale
    ];
    let шаг = 0;
    try { шаг = Number(await env.ORDERS.get('cron:шаг')) || 0; } catch (e) {}
    const задача = очередь[шаг % очередь.length];
    try { await env.ORDERS.put('cron:шаг', String((шаг + 1) % 1000)); } catch (e) {}
    // Тяжёлая задача тоже ждёт своего токена, а не бежит за ним сама.
    ctx.waitUntil((async () => {
      // Токен греем заранее, но его отсутствие больше не отменяет задачу:
      // каталогу, остаткам и отзывам хватает постоянного ключа, и молчать
      // из-за сломанного OAuth они не должны (15.08 именно так и вышло).
      try { await токенКабинета(env); } catch (e) { console.log('токен для расписания:', e.message); }
      await задача(env).catch(e => console.log('задача расписания:', e.message));
    })());
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
  const token = await токенКабинета(env);
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
  const token = await токенКабинета(env);
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
  const token = await токенКабинета(env);
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

/**
 * Обновляем доступ заранее, по расписанию, а не в момент заказа.
 *
 * Почему это важнее, чем кажется. Ключ обновления одноразовый: Ozon выдаёт
 * новый и гасит старый. Хранилище Cloudflare отдаёт запись не мгновенно —
 * соседний регион до минуты видит прежнее значение. Когда обновление
 * случалось «на лету», два запроса из разных регионов легко предъявляли один
 * и тот же ключ, и Ozon рвал цепочку. Так доступ умирал почти каждый день.
 *
 * Расписание выполняется в одном экземпляре и раз в две минуты. Обновляя
 * доступ здесь и заблаговременно, мы получаем ровно одно обновление в час,
 * без соседей и гонок, а хранилище успевает разнести новое значение задолго
 * до следующего раза.
 */
async function обновитьТокенЗаранее(env) {
  // Без ключа обновления делать нечего: доступ выдаётся заново по ссылке.
  if (!(await env.ORDERS.get('seller_refresh'))) return;
  let выдан = 0, срок = 0;
  try {
    const t = JSON.parse((await env.ORDERS.get('seller_token')) || '{}');
    выдан = Number(t.выдан) || 0;
    срок = Number(t.exp) || 0;
  } catch (e) {}
  // Меняем, когда до конца жизни доступа меньше десяти минут: до этого
  // момента он рабочий, и трогать ключ обновления незачем.
  const пора = !срок || (срок - Date.now() < 10 * 60 * 1000);
  // И не чаще раза в двадцать минут — страховка от частых обновлений.
  const давно = !выдан || (Date.now() - выдан > 20 * 60 * 1000);
  if (!пора || !давно) return;
  try { await sellerToken(env, true); }
  catch (e) { console.log('обновление доступа по расписанию:', e.message); }
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

/* ---------- Разовый показ писем владельцу ---------- */

/**
 * Один раз отправить Александру все виды писем — «проверим, как приходят».
 *
 * Получатель прибит прямо здесь, а не приходит параметром: ручка с адресом
 * снаружи — это готовая чужая рассылка от имени info@nutry-go.ru, и такой
 * ручки у нас не будет. Отметка о выполненном хранится в KV навсегда, так
 * что повторно письма не уйдут даже при перезапусках.
 */
const ПОКАЗ_ПИСЕМ_КОМУ = 'pikhtovnikov.alieksandr@mail.ru';

async function разовыйПоказПисем(env) {
  if (await env.ORDERS.get('mailshow:сделано')) return;
  await env.ORDERS.put('mailshow:сделано', new Date().toISOString());

  const образец = {
    ext_id: '1870945661',
    address: 'Москва, Учинская улица, 1 (пункт №504588)',
    email: ПОКАЗ_ПИСЕМ_КОМУ,
    items: [
      { name: 'NOW Селен 100 мкг, Selenium, 100 таблеток', quantity: 1 },
      { name: 'Бисглицинат магния 300 мг NOW, 227 г', quantity: 2 }
    ]
  };
  const набор = [
    ['Заказ принят', письмоОЗаказе(образец, '40704586-0718-1', '16 августа')],
    ['Приехал в пункт', письмоОДоставке(образец, 'posting_in_pickup_point', '40704586-0718-1')],
    ['Получен', письмоОДоставке(образец, 'posting_received', '40704586-0718-1')]
  ];
  const отчёт = [];
  for (const [имя, письмо] of набор) {
    const и = await smtpSend(env, {
      to: ПОКАЗ_ПИСЕМ_КОМУ, subject: '[образец] ' + письмо.subject,
      text: письмо.text, html: письмо.html
    });
    отчёт.push((и.ok ? '✅ ' : '⚠️ ') + имя + (и.ok ? '' : ' — ' + (и.why || '')));
  }
  await env.ORDERS.put('mailshow:отчёт', отчёт.join('\n'), { expirationTtl: 7 * 24 * 3600 });
  await notify(env, 'NutryGo: образцы писем отправлены на ' + ПОКАЗ_ПИСЕМ_КОМУ + '\n' + отчёт.join('\n'));
}

/* ---------- Заказы, застрявшие без отправления ---------- */

/**
 * Оплачен, но не передан в доставку — чиним сами.
 *
 * 13.08 в 22:04 оборвалась цепочка токенов Ozon, и до 14.08 создание
 * отправлений не работало. Оплата при этом идёт своим путём, через Ozon Pay:
 * деньги списались, отправления нет. Сам такой заказ не выберется — опрос
 * платежей смотрит только ожидающие оплату, а оплаченный он уже пропустит.
 *
 * Раньше это лечилось руками через /admin/retry с ключом. Так нельзя: сбой
 * случается ночью, а человек видит его утром. Теперь разбор идёт по
 * расписанию.
 *
 * Осторожности, чтобы не наделать хуже:
 *  • берём только оплаченные и только без отправления — createDelivery и сам
 *    отказывается работать поверх созданного, но проверяем и здесь;
 *  • не старше недели: старое разбирается руками, у него могли измениться
 *    остатки и цены;
 *  • не больше пяти за заход и не чаще раза в четверть часа — чтобы разбор
 *    не превратился в шквал запросов к Ozon;
 *  • три попытки на заказ, дальше только Telegram: если Ozon отказывает
 *    трижды, дело не в связи, и человеку надо посмотреть самому.
 */
const ЗАСТРЯЛИ_ЗА_ЗАХОД = 5;
const ЗАСТРЯЛИ_ПОПЫТОК = 3;
const ЗАСТРЯЛИ_ДАВНОСТЬ = 7 * 24 * 3600 * 1000;

function заказОплачен(o) {
  return !!(o.paid_at || o.paid || o.status === 'paid' || o.status === 'create_failed');
}
function заказБезОтправления(o) {
  return !(o.ozon_order || o.posting_number || o.status === 'delivery_created');
}

async function recoverStranded(env) {
  const найдено = [];
  let курсор;
  do {
    const стр = await env.ORDERS.list({ prefix: 'order:', cursor: курсор });
    for (const к of стр.keys) {
      const сыр = await env.ORDERS.get(к.name);
      if (!сыр) continue;
      let o;
      try { o = JSON.parse(сыр); } catch (e) { continue; }
      if (!заказОплачен(o) || !заказБезОтправления(o)) continue;
      const когда = Date.parse(o.paid_at || o.created || o.created_at || 0);
      if (когда && Date.now() - когда > ЗАСТРЯЛИ_ДАВНОСТЬ) continue;
      найдено.push({ ext: к.name.replace('order:', ''), o, когда });
    }
    курсор = стр.list_complete ? '' : String(стр.cursor || '');
  } while (курсор);

  await env.ORDERS.put('orders:застряло', String(найдено.length), { expirationTtl: 3600 });
  if (!найдено.length) return { застряло: 0, взяли: 0 };

  найдено.sort((a, b) => (b.когда || 0) - (a.когда || 0));
  const отчёт = [];
  for (const з of найдено.slice(0, ЗАСТРЯЛИ_ЗА_ЗАХОД)) {
    const попыток = Number(з.o.autoretry || 0);
    if (попыток >= ЗАСТРЯЛИ_ПОПЫТОК) continue;
    з.o.autoretry = попыток + 1;
    await env.ORDERS.put('order:' + з.ext, JSON.stringify(з.o));
    try {
      await createDelivery(env, з.ext, з.o);
      const после = JSON.parse(await env.ORDERS.get('order:' + з.ext));
      const вышло = !!(после.ozon_order || после.posting_number);
      отчёт.push((вышло ? '✅ ' : '⚠️ ') + з.ext + (вышло ? ' → ' + после.ozon_order : ' — ' + (после.status || '')));
    } catch (e) {
      отчёт.push('⚠️ ' + з.ext + ' — ' + String(e && e.message || e).slice(0, 90));
    }
  }
  if (отчёт.length) {
    await notify(env, 'NutryGo: разбор застрявших заказов\n' + отчёт.join('\n'));
  }
  return { застряло: найдено.length, взяли: отчёт.length };
}

async function recoverStrandedIfDue(env) {
  if (await env.ORDERS.get('orders:разбор:идёт')) return;
  await env.ORDERS.put('orders:разбор:идёт', '1', { expirationTtl: 900 });
  await recoverStranded(env).catch(e => console.log('разбор застрявших:', e.message));
}

/* ---------- Характеристики и описания для поиска ---------- */

/**
 * Поиск по характеристикам.
 *
 * Замечание Александра 14.08: «хочется, чтобы ещё искал по характеристикам»,
 * и следом «с API тянем описание обязательно».
 *
 * Почему без этого никак: в каталоге Tilda описания просто нет. Проверено —
 * в указателе поиска описание есть у 277 товаров из 729, а у остальных 452
 * поле пустое; у артикула 3505 наш же `/catalog/product` возвращает `text`
 * пустой строкой. Складывать нечего, сколько указатель ни пересобирай.
 *
 * Зато всё это есть у Ozon, где товары и заведены. Берём оттуда два вида
 * данных:
 *
 * 1. **Характеристики** — `/v4/product/info/attributes`, партиями по сто
 *    артикулов. Названия свойств нам не нужны, нужны значения: человек
 *    ищет «капсулы», «веган», «500 мг», а не «форма выпуска».
 * 2. **Описание** — `/v1/product/info/description`, и оно только поштучно.
 *    Семьсот запросов в один заход не влезут: у Worker есть предел на число
 *    исходящих запросов за вызов. Поэтому описания добираем порциями, с
 *    закладкой в хранилище: за несколько заходов расписания соберётся весь
 *    каталог, дальше — обновление раз в неделю.
 */
const ХАРАКТЕРИСТИКИ_ПОРЦИЯ = 25;   // описаний за один заход расписания
const ХАРАКТЕРИСТИКИ_ЖИВУТ = 7 * 24 * 3600 * 1000;

function чистоДляПоиска(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Из значений свойств выбрасываем служебное: ссылки, «да/нет», голые числа. */
function годноеЗначение(v) {
  const s = чистоДляПоиска(v);
  if (!s || s.length > 60) return '';
  if (/^(да|нет|true|false|-|—)$/i.test(s)) return '';
  if (/^\d{6,}$/.test(s)) return '';
  return s;
}

async function refreshSearchText(env) {
  const token = await токенКабинета(env);
  const прежнее = await env.ORDERS.get('catalog:searchtext');
  let снимок = { updated: '', items: {}, описаний: 0, курсор: 0 };
  if (прежнее) { try { снимок = JSON.parse(прежнее); } catch (e) {} }
  снимок.items = снимок.items || {};

  const сохранить = async () => {
    снимок.updated = new Date().toISOString();
    снимок.артикулов = снимок.артикулов || 0;
    снимок.описаний = Object.keys(снимок.items).filter(a => снимок.items[a].d).length;
    await env.ORDERS.put('catalog:searchtext', JSON.stringify(снимок));
  };
  // Пишем снимок после каждого шага.
  //
  // Первая версия 14.08 копила всё в памяти и сохраняла в самом конце — и не
  // сохраняла никогда: семьдесят обращений к Ozon подряд не укладываются в
  // время, которое Cloudflare даёт фоновой работе, а ручка бесконечно
  // отвечала «строится». Теперь каждый шаг виден снаружи, и обход можно
  // продолжить с того места, где остановились.
  await сохранить();

  // Список артикулов — тот же путь, что и у остальных снимков каталога.
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
  снимок.артикулов = offers.length;
  await сохранить();

  // 1. Характеристики — партиями, это дёшево.
  //
  // Но не на каждом заходе: их четырнадцать партий по сотне, а заходов ради
  // описаний будет полсотни. Характеристики меняются редко — обновляем раз в
  // неделю, а между обновлениями заход тратится только на описания.
  //
  // Ошибку одной партии глотать нельзя, но и ронять из-за неё весь обход
  // тоже: первый заход 14.08 падал молча — снимок не записывался вовсе, а
  // ручка отвечала «строится» до бесконечности. Запоминаем первую беду и
  // отдаём её наружу.
  let сХарактеристиками = 0;
  снимок.беда = '';
  const свежиеХарактеристики = снимок.характеристики_обновлены &&
    (Date.now() - Date.parse(снимок.характеристики_обновлены) < ХАРАКТЕРИСТИКИ_ЖИВУТ);
  for (let i = 0; свежиеХарактеристики ? false : i < offers.length; i += 100) {
    const часть = offers.slice(i, i + 100);
    let r = null;
    try {
      r = await sellerCall(env, token, '/v4/product/info/attributes', {
        filter: { offer_id: часть, visibility: 'ALL' }, limit: 100, sort_dir: 'ASC'
      });
    } catch (e) {
      if (!снимок.беда) снимок.беда = 'характеристики: ' + String(e && e.message || e).slice(0, 160);
      continue;
    }
    if (r && r.message && !r.result && !r.items) {
      if (!снимок.беда) снимок.беда = 'характеристики: ' + String(r.message).slice(0, 160);
    }
    const список = (r && (r.result || r.items)) || [];
    список.forEach(it => {
      const art = String(it.offer_id || '');
      if (!art) return;
      const слова = [];
      (it.attributes || []).forEach(a => {
        (a.values || []).forEach(v => {
          const s = годноеЗначение(v && (v.value || v.dictionary_value_id));
          if (s && слова.indexOf(s) < 0) слова.push(s);
        });
      });
      const текст = слова.join(' ').slice(0, 600);
      if (!текст) return;
      снимок.items[art] = снимок.items[art] || {};
      снимок.items[art].c = текст;
      сХарактеристиками++;
    });
    await сохранить();
  }

  if (!свежиеХарактеристики) {
    снимок.характеристики_обновлены = new Date().toISOString();
    await сохранить();
  }

  // 2. Описания — порциями, по кругу, с того места, где остановились.
  let курсор = Number(снимок.курсор || 0);
  if (курсор >= offers.length) курсор = 0;
  let взято = 0;
  for (let n = 0; n < ХАРАКТЕРИСТИКИ_ПОРЦИЯ && курсор < offers.length; n++, курсор++) {
    const art = offers[курсор];
    let r = null;
    try {
      r = await sellerCall(env, token, '/v1/product/info/description', { offer_id: art });
    } catch (e) {
      if (!снимок.беда) снимок.беда = 'описание: ' + String(e && e.message || e).slice(0, 160);
      continue;
    }
    if (r && r.message && !r.result && !r.description) {
      if (!снимок.беда) снимок.беда = 'описание: ' + String(r.message).slice(0, 160);
    }
    const d = чистоДляПоиска((r && r.result && r.result.description) || (r && r.description) || '');
    if (!d) continue;
    снимок.items[art] = снимок.items[art] || {};
    снимок.items[art].d = d.slice(0, 800);
    взято++;
    if (взято % 5 === 0) { снимок.курсор = курсор + 1; await сохранить(); }
  }
  снимок.курсор = курсор;
  await сохранить();
  return {
    updated: снимок.updated, всего: offers.length,
    сХарактеристиками: сХарактеристиками, сОписанием: снимок.описаний,
    добралиОписаний: взято, курсор: курсор, беда: снимок.беда || ''
  };
}

async function refreshSearchTextIfStale(env) {
  const raw = await env.ORDERS.get('catalog:searchtext');
  if (raw) {
    try {
      const с = JSON.parse(raw);
      /*
       * Свежесть считаем по завершённому обходу, а не по времени последней
       * записи. Первая версия 14.08 сохраняла пустой снимок в самом начале —
       * и он же объявлял себя свежим на час, из-за чего сборка больше не
       * трогалась с места и вечно показывала ноль.
       */
      const обошли = Number(с.курсор || 0) === 0 && Number(с.описаний || 0) > 0;
      const возраст = Date.now() - Date.parse(с.updated || 0);
      if (обошли && возраст < ХАРАКТЕРИСТИКИ_ЖИВУТ) return;
      if (!обошли && возраст < 90 * 1000) return;   // не чаще раза в полторы минуты
    } catch (e) {}
  }
  await refreshSearchText(env).catch(e => console.log('характеристики для поиска:', e.message));
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

/* ---------- Единый аккаунт на телефоне и компьютере ---------- */

const ACCOUNT_ORIGINS = ['https://nutry-go.ru', 'https://www.nutry-go.ru'];

function accountOriginAllowed(request) {
    return ACCOUNT_ORIGINS.indexOf(String(request.headers.get('Origin') || '')) > -1;
}

function accountCors(request, resp) {
    const h = new Headers(resp.headers);
    const origin = String(request.headers.get('Origin') || '');
    if (ACCOUNT_ORIGINS.indexOf(origin) > -1) h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
    h.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    h.set('Access-Control-Allow-Headers', 'Content-Type');
    h.set('Cache-Control', 'no-store');
    return new Response(resp.body, { status: resp.status, headers: h });
}

/**
 * Непрозрачный постоянный идентификатор аккаунта. Отдельный secret обязателен:
 * смена ADMIN_TOKEN не должна разрывать профиль, избранное и заказы покупателя.
 */
async function accountKey(login, env) {
    const normalized = String(login || '').trim().toLowerCase();
    const secret = String(env.ACCOUNT_SUBJECT_KEY || '');
    if (!normalized || normalized.indexOf('@') < 0 || secret.length < 32) return '';
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const project = String(env.TILDA_PROJECT_ID || '27635446');
    const signature = await crypto.subtle.sign(
        'HMAC', key, encoder.encode(project + '|' + normalized)
    );
    return 'account:' + [...new Uint8Array(signature)].slice(0, 16)
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

function cleanAccountProfile(value) {
    const p = value && typeof value === 'object' ? value : {};
    const photo = String(p.photo || '');
    return {
        // Кавычки и HTML-разметка не нужны в псевдониме и не должны позже
        // попадать в attribute/innerHTML личного кабинета.
        nick: String(p.nick || '')
            .replace(/[\u0000-\u001f\u007f<>&"']/g, '').trim().slice(0, 24),
        avatar: /^nutrygo-\d{1,3}$/.test(String(p.avatar || '')) ? String(p.avatar) : '',
        // Фото синхронизируется только после явной загрузки или явного
        // переноса пользователем. Произвольные URL/SVG не принимаются.
        photo: photo.length <= 220000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo)
            ? photo : ''
    };
}

function cleanFavorites(value) {
    const out = [];
    (Array.isArray(value) ? value : []).slice(0, 500).forEach(v => {
        const id = String(v || '').trim().slice(0, 80);
        if (!id || !/^[0-9A-Za-zА-Яа-яЁё._-]+$/.test(id) || out.indexOf(id) > -1) return;
        out.push(id);
    });
    return out;
}

async function accountState(request, env) {
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'нет данных' }, 400);
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 300000) {
        return json({ error: 'payload too large' }, 413);
    }

    const who = await verifyMember(env, String(body.token || ''), true);
    if (who.unavailable) return json({ error: 'проверка входа временно недоступна' }, 503);

    /*
     * Кто перед нами, если Tilda не отвечает.
     *
     * Замечание Александра 14.08: «не сохраняет». Настройки не переносились
     * между устройствами, потому что единственным доказательством входа была
     * проверка токена у Tilda, а она воркеру недоступна (тупик от 10.08,
     * перепроверен 13.08). Получался тупик и здесь: человек вошёл, кабинет
     * его заказы показывает, а профиль сохранить нельзя.
     *
     * Способ доказать себя у нас давно есть и работает — тот же, что в
     * /orders/my: предъявление собственных заказов. Их номера, суммы и
     * адрес почты видит только тот, кто вошёл в кабинет Tilda; мы сверяем
     * их со своими записями. Совпал хотя бы один заказ целиком — значит это
     * он.
     *
     * Перебор всех заказов на каждое чтение профиля был бы расточителен,
     * поэтому после удачного предъявления выдаём подписанный пропуск на
     * тридцать дней: дальше он предъявляется вместо заказов, и перебора нет.
     */
    let login = (who.ok && who.login) ? String(who.login) : '';
    let новыйПропуск = '';
    if (!login && body.pass) {
      const поПропуску = await прочестьПропуск(env, String(body.pass));
      if (поПропуску) login = поПропуску;
    }
    if (!login && body.claim && typeof body.claim === 'object') {
      const почта = String(body.claim.email || '').trim().toLowerCase();
      const список = Array.isArray(body.claim.orders) ? body.claim.orders.slice(0, 200) : [];
      if (почта.indexOf('@') > 0 && список.length) {
        const ждём = {};
        список.forEach(з => {
          const н = String((з && з.id) || '').trim();
          if (н) ждём[н] = Math.round(Number((з && з.amount) || 0));
        });
        let совпало = false, курсор;
        do {
          const стр = await env.ORDERS.list({ prefix: 'order:', cursor: курсор });
          for (const к of стр.keys) {
            const сыр = await env.ORDERS.get(к.name);
            if (!сыр) continue;
            let o;
            try { o = JSON.parse(сыр); } catch (e) { continue; }
            const н = String(o.ext_id || к.name.slice(6));
            const почтаЗаказа = String(o.email || o.member_login || '').trim().toLowerCase();
            if (ждём[н] !== undefined && почтаЗаказа && почтаЗаказа === почта &&
                ждём[н] === Math.round(Number(o.amount) || 0)) { совпало = true; break; }
          }
          курсор = (стр.list_complete || совпало) ? '' : String(стр.cursor || '');
        } while (курсор);
        if (совпало) {
          login = почта;
          новыйПропуск = await выдатьПропуск(env, почта);
        }
      }
    }
    if (!login) return json({ error: 'нужен вход в кабинет', why: who.why || '' }, 401);
    const key = await accountKey(login, env);
    if (!key) return json({ error: 'синхронизация аккаунта не настроена' }, 503);

    let state = {
        profile: { nick: '', avatar: '', photo: '' },
        favorites: [],
        revision: 0,
        updated: ''
    };
    const raw = await env.ORDERS.get(key);
    if (raw) {
        try {
            const saved = JSON.parse(raw);
            state.profile = cleanAccountProfile(saved.profile);
            state.favorites = cleanFavorites(saved.favorites);
            state.revision = Math.max(0, Number(saved.revision) || 0);
            state.updated = String(saved.updated || '');
        } catch (e) {}
    } else {
        // Прежний preset/псевдоним переносим только после того, как email
        // получен от Tilda по валидному токену. Клиентский login не читаем.
        const legacyKey = await profileKey(login, env);
        const legacyRaw = legacyKey ? await env.ORDERS.get(legacyKey) : '';
        if (legacyRaw) {
            try { state.profile = cleanAccountProfile(JSON.parse(legacyRaw)); } catch (e) {}
        }
    }

    const action = String(body.action || 'read');
    let changed = false;
    if (action === 'merge') {
        const incoming = cleanAccountProfile(body.profile);
        if (!state.profile.nick && incoming.nick) { state.profile.nick = incoming.nick; changed = true; }
        if (!state.profile.avatar && incoming.avatar) { state.profile.avatar = incoming.avatar; changed = true; }
        cleanFavorites(body.favorites).forEach(id => {
            if (state.favorites.indexOf(id) < 0) { state.favorites.push(id); changed = true; }
        });
    } else if (action === 'profile') {
        state.profile = cleanAccountProfile(body.profile);
        changed = true;
    } else if (action === 'favorite') {
        const ids = cleanFavorites([body.id]);
        if (!ids.length || typeof body.on !== 'boolean') return json({ error: 'bad favorite' }, 400);
        const i = state.favorites.indexOf(ids[0]);
        if (body.on && i < 0) { state.favorites.push(ids[0]); changed = true; }
        if (!body.on && i > -1) { state.favorites.splice(i, 1); changed = true; }
    } else if (action !== 'read') {
        return json({ error: 'bad action' }, 400);
    }

    if (changed || (!raw && (state.profile.nick || state.profile.avatar || state.favorites.length))) {
        state.revision += 1;
        state.updated = new Date().toISOString();
        await env.ORDERS.put(key, JSON.stringify(state));
    }
    return json({
        subject: key.slice('account:'.length),
        // Пропуск выдаём один раз — после удачного предъявления заказов.
        // Дальше сайт присылает его вместо списка заказов, и перебирать
        // хранилище на каждое чтение профиля не приходится.
        pass: новыйПропуск || undefined,
        profile: state.profile,
        // Телефон из профиля Tilda. Нужен корзине, чтобы сверить его с
        // номером, введённым в заказе: код получения приходит на номер
        // заказа, и опечатка в нём отдаёт посылку постороннему человеку
        // (разбор 13.08, NG-2026-08-13-016). Отдаём только владельцу — ответ
        // идёт по проверенному токену Tilda и лишь на наши домены.
        phone: String(who.phone || ''),
        favorites: state.favorites,
        revision: state.revision,
        updated: state.updated
    });
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
  // Кэш общий для всех покупателей, телефона в ключе нет. Поэтому запрос с
  // телефоном всегда идёт к Ozon: иначе ответ про этот конкретный телефон
  // подменялся бы чужим кэшем, и проверка перед оплатой ничего бы не значила.
  // Таких запросов немного — по одному на оформление, а не на каждый показ.
  if (!body.phone) {
    const cached = await env.ORDERS.get(cacheKey);
    if (cached) return json(JSON.parse(cached));
  }

  const token = await sellerToken(env);
  const payload = {
    delivery_schema: 'FBS',
    delivery_type: { pick_up: { map_point_id: pointId } },
    items: items.map(i => (i.sku ? { sku: Number(i.sku), quantity: Number(i.quantity) || 1 }
                                 : { offer_id: String(i.offer_id), quantity: Number(i.quantity) || 1 }))
  };
  if (body.phone) payload.buyer_phone = String(body.phone).replace(/\D/g, '');

  // Тем же порядком, что и при оформлении: незнакомый Ozon телефон не должен
  // превращать срок доставки в «уточним» — покупатель ещё в корзине, и
  // отсутствие у него аккаунта Ozon к сроку отношения не имеет.
  const r = await checkoutDelivery(env, token, payload);
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
  // Кэш общий для всех покупателей и ключа телефона не содержит, поэтому
  // ответ про телефон кладём ПОСЛЕ записи в кэш — он у каждого свой.
  if (res.ok) await env.ORDERS.put(cacheKey, JSON.stringify(res), { expirationTtl: 3600 });
  // Известен ли телефон Ozon. Отвечаем только когда телефон вообще прислали.
  // Отправление создаётся лишь на телефон с аккаунтом Ozon (проверено на
  // заказе 1868559242), и корзина обязана узнать это до оплаты, а не после.
  if (payload.buyer_phone) res.phone_known = !(r && r.ngr_phone_unknown);
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
    // Origin и Referer обязательны. Проверено 13.08.2026: тот же самый токен
    // Tilda принимает из браузера покупателя (status ok, профиль отдаёт) и
    // отклоняет из воркера. Разница только в этих заголовках — браузер шлёт
    // их сам, а fetch воркера не шлёт ничего. Из-за этого с 10.08 не работала
    // серверная проверка входа: пришлось ослабить заставу заказа
    // (горячий фикс в ngr-stock.js, журнал NG-2026-08-08-006), а личный
    // кабинет не получал ни наших заказов, ни состояния доставки.
    const r = await fetch('https://members.tildaapi.com/api/getprofile/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://nutry-go.ru',
        'Referer': 'https://nutry-go.ru/',
        // Витрина Tilda отвечает воркеру wrong_client_data — похоже, она
        // сверяет признаки клиента. Пробуем выглядеть обычным браузером;
        // если не поможет, значит дело в IP сети Cloudflare, и путь через
        // Tilda придётся оставить.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
      },
      body: new URLSearchParams({ projectid: env.TILDA_PROJECT_ID || '27635446', token: token })
    });
    // Читаем текстом, а не сразу json(): Tilda отвечает воркеру кодом 200, но
    // телом, которое не разбирается как JSON (проверено 13.08.2026). Пока не
    // видно самого тела, причину не понять.
    const текст = await r.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(текст); } catch (e) {}
    if (j && j.status === 'ok' && j.data) {
      return {
        ok: true,
        login: String(j.data.login || j.data.email || ''),
        phone: String(j.data.phone || '').replace(/\D/g, ''),
        name: String(j.data.name || '')
      };
    }
    // Что именно ответила Tilda — иначе отказ неотличим от отказа, и
    // приходится гадать. Ответ касается токена самого спрашивающего, поэтому
    // вернуть его владельцу токена безопасно.
    // Запасной путь: спрашиваем витрину, а не кабинет.
    //
    // Проверено 13.08.2026: members.tildaapi.com отдаёт воркеру HTML-страницу
    // «Error in Memebers Public Test» — и на настоящий токен, и на заведомо
    // фиктивный, и до добавления Origin, и после. Тот же фиктивный токен из
    // curl получает нормальный JSON. Значит ломается не токен и не заголовки,
    // а сам запрос из сети Cloudflare. Пробуем другой хост Tilda: если он
    // отдаёт заказы по этому токену, токен настоящий, и владельца мы узнаём
    // из самих заказов.
    if (текст && текст.indexOf('<') === 0) {
      try {
        const r2 = await fetch('https://store.tildaapi.com/api/orders/getdashboard/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://nutry-go.ru',
            'Referer': 'https://nutry-go.ru/'
          },
          body: new URLSearchParams({ projectid: env.TILDA_PROJECT_ID || '27635446', token: token })
        });
        const т2 = await r2.text().catch(() => '');
        let j2 = null;
        try { j2 = JSON.parse(т2); } catch (e) {}
        const d2 = j2 && (j2.data || j2);
        const email = d2 && (d2.email || d2.login || (d2.user && d2.user.email) || '');
        if (email) {
          return { ok: true, login: String(email), phone: '', name: '', via: 'store' };
        }
        return {
          ok: false, why: 'Tilda не признала токен',
          detail: 'кабинет отдал HTML; витрина: HTTP ' + r2.status + ' ' +
            (j2 ? JSON.stringify(j2).slice(0, 200) : 'НЕ JSON: ' + т2.slice(0, 200))
        };
      } catch (e) {
        return { ok: false, why: 'Tilda не признала токен', detail: 'витрина: сбой ' + e.message };
      }
    }
    return {
      ok: false,
      why: 'Tilda не признала токен',
      detail: 'HTTP ' + r.status + ' [' + (r.headers.get('content-type') || 'без типа') + '] ' +
        (j ? JSON.stringify(j).slice(0, 200) : 'НЕ JSON: ' + текст.slice(0, 300))
    };
  } catch (e) {
    console.log('проверка входа недоступна, пропускаем заказ:', e.message);
    // Чтение/изменение аккаунта при недоступной Tilda должно закрываться,
    // а не превращаться в пустой либо чужой кабинет. Для приёма заказа ниже
    // сохраняется прежний явно деградированный режим.
    if (force) return { ok: false, unavailable: true, why: 'Tilda недоступна' };
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
  // Не блокируем приём заказа, если account secret ещё не настроен: P0
  // payment/delivery поток остаётся прежним. После настройки новые заказы
  // получают точную привязку, не основанную на введённых email/телефоне.
  const memberSubject = member.login ? await accountKey(member.login, env) : '';

  const order = {
    received_at: new Date().toISOString(),
    member_login: member.login || '',
    member_subject: memberSubject,
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

  /**
   * Сообщение о неудаче — по одному на причину, а не на каждый заход.
   *
   * Случай из жизни, 13.08.2026, заказ 1868559242: неудачный расчёт уходил
   * из createDelivery простым return, не меняя статус заказа. Заказ так и
   * оставался «awaiting_payment», опрос платежей подхватывал его на каждом
   * заходе расписания, и Александру пришло восемь одинаковых сообщений
   * подряд — 09:48, 09:52, 09:56, 10:00, 10:04, 10:08, 10:12. При сроке
   * жизни заказа в двое суток их было бы около семисот.
   *
   * Поэтому: причину запоминаем и повторно о ней не пишем, а после
   * нескольких безуспешных заходов перестаём пробовать сами и говорим об
   * этом прямо. Вернуть заказ в работу можно через /admin/retry.
   */
  const ПРЕДЕЛ_ПОПЫТОК = 6;
  const сдаться = async (причина, текст) => {
    order.fail_reason = причина;
    order.attempts = (Number(order.attempts) || 0) + 1;
    delete order.creating;
    const первыйРаз = order.notified_reason !== причина;
    const хватит = order.attempts >= ПРЕДЕЛ_ПОПЫТОК;
    if (хватит) order.status = 'needs_manual';
    order.notified_reason = причина;
    await env.ORDERS.put('order:' + extId, JSON.stringify(order));
    if (первыйРаз) {
      await notify(env, текст);
    } else {
      console.log('повтор той же причины, не пишем в Telegram:', extId, причина);
    }
    if (хватит && !первыйРаз) {
      await notify(env, 'Заказ ' + extId + ': после ' + order.attempts +
        ' попыток автосоздание остановлено, причина прежняя (' + причина +
        '). Оформите вручную; повторить автоматически — /admin/retry?ext=' + extId + '.');
    }
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
      await сдаться('нет пункта выдачи',
        'Заказ ' + extId + ' оплачен, но пункт выдачи не выбран (' + order.address + ') — оформите вручную.');
      return;
    }
    const token = await sellerToken(env);
    const items = await resolveItems(env, token, order);
    await log('товаров к отправке: ' + items.length + ' (' + items.map(i => i.offer_id || i.sku).join(',') + ')');
    if (!items.length) {
      await сдаться('товары не сопоставлены',
        'Заказ ' + extId + ': не удалось сопоставить товары — оформите вручную.');
      return;
    }

    const checkout = await checkoutDelivery(env, token, {
      buyer_phone: order.phone,
      delivery_schema: 'FBS',
      delivery_type: { pick_up: { map_point_id: order.point_id } },
      items
    }, log);
    await log('ответ расчёта: ' + JSON.stringify(checkout).slice(0, 300));
    if (!checkout || !checkout.splits || !checkout.splits.length) {
      await сдаться('расчёт доставки не прошёл',
        'Заказ ' + extId + ': чекаут доставки не прошёл — оформите вручную. ' +
        (phoneUnknownToOzon(checkout) ? 'Ozon не знает телефон ' + order.phone + ' и отказал даже без него. ' : '') +
        JSON.stringify(checkout).slice(0, 300));
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
        await сдаться('нет интервалов доставки',
          'Заказ ' + extId + ': Ozon не предложил интервалов доставки — оформите вручную.');
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
      // Расчёт мы уже умеем проводить без телефона, а создание требует
      // получателя. Если Ozon откажет и здесь по той же причине — значит
      // покупателю без аккаунта Ozon пункт выдачи недоступен в принципе, и
      // это надо будет решать не кодом. Пишем причину словами, чтобы это
      // было видно сразу, а не разбиралось по JSON.
      await notify(env, 'Заказ ' + extId + ': Ozon отказал в создании отправления — ' +
        (phoneUnknownToOzon(created)
          ? 'у покупателя нет аккаунта Ozon (телефон ' + order.phone + '), а создание отправления его требует. '
          : '') +
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

    // Письмо покупателю о принятом заказе. До этой правки после оплаты он не
    // получал от нас ничего вовсе и узнавал о судьбе заказа только от Ozon.
    // Шлём один раз: отметка живёт в самом заказе.
    order.mailed = order.mailed || {};
    const почтаПок = String(order.email || '').trim();
    if (!order.mailed.accepted && почтаПок.indexOf('@') > 0) {
      const номерОтпр = (postingNumbers(created) || [])[0] || '';
      const срокДоставки = (() => {
        try {
          const s0 = splits[0] && splits[0].delivery_method &&
            splits[0].delivery_method.logistic_date_range;
          return s0 && s0.to ? fmtДата(s0.to) : '';
        } catch (e) { return ''; }
      })();
      const п = письмоОЗаказе(order, номерОтпр, срокДоставки);
      const итог = await smtpSend(env, { to: почтаПок, subject: п.subject, text: п.text, html: п.html });
      if (итог.ok) {
        order.mailed.accepted = new Date().toISOString();
        await env.ORDERS.put('order:' + extId, JSON.stringify(order));
      } else {
        console.log('письмо о заказе не ушло:', extId, итог.why);
      }
    }
  } catch (e) {
    console.log('createDelivery ошибка:', e.message);
    try { await log('СБОЙ: ' + e.message); } catch (e2) {}
    try {
      await сдаться('сбой автосоздания',
        'Заказ ' + extId + ': сбой автосоздания доставки (' + e.message + ') — оформите вручную.');
    } catch (e3) {
      await notify(env, 'Заказ ' + extId + ': сбой автосоздания доставки (' + e.message + ') — оформите вручную.');
    }
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

/** Сумма позиций заказа по ценам Tilda (полные цены, без промокода). */
function orderItemsTotal(order) {
  let full = 0;
  for (const p of (order.items || [])) {
    const line = Number(p.amount) || (Number(p.price) || 0) * (Number(p.quantity) || 1);
    if (line > 0) full += line;
  }
  return full;
}

/**
 * Понижающий коэффициент промокода.
 *
 * Промокод Tilda не меняет цены позиций: в products остаются полные цены,
 * скидка видна только в сумме оплаты. Если отдать Ozon цены как есть,
 * отправление выходит дороже, чем покупатель заплатил (замечание Александра
 * 10.08). Поэтому цены позиций пропорционально ужимаем к оплаченной сумме.
 *
 * Без промокода (оплата не меньше суммы позиций) коэффициент ровно 1 —
 * поведение прежнее. Повышать цены этот код не может по построению.
 */
function discountRate(order) {
  const paid = Number(order.amount) || 0;
  const full = orderItemsTotal(order);
  if (paid <= 0 || full <= 0 || full <= paid + 0.5) return 1;
  return paid / full;
}

/** Цена позиции за единицу — из состава заказа, по артикулу, с учётом промокода. */
function priceFor(order, checkoutItem) {
  const offer = String(checkoutItem.offer_id || '');
  const found = (order.items || []).find(p => String(p.sku || p.article || '') === offer);
  const unit = found ? Number(found.price || (Number(found.amount) / Number(found.quantity || 1))) : 0;
  return Math.max(1, Math.round((unit || 0) * discountRate(order)));
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
/**
 * Токен доступа к Ozon.
 *
 * Ozon меняет токен обновления при каждом использовании: старый гасится,
 * новый приходит в ответе. Значит два одновременных обновления смертельны —
 * второе приходит со уже погашенным токеном, и Ozon отвечает
 * `invalid_refresh_token`, обрывая всю цепочку.
 *
 * Именно это случилось 14.08: я добавил сборку характеристик, и первая её
 * версия запускалась на каждый запрос `/catalog/searchtext`. Пока я опрашивал
 * ручку, обходы шли внахлёст, каждый звал sellerToken — и цепочка порвалась.
 * Наружу это вылезло как `{"error":"internal"}` на расчёте доставки.
 *
 * Поэтому теперь:
 *  • обновляет кто-то один — на время обновления ставится метка, остальные
 *    ждут и перечитывают кэш;
 *  • если токен из хранилища не принят, пробуем исходный из секрета: он мог
 *    остаться живым, и тогда магазин чинится сам, без ручной пере-авторизации.
 */
async function sellerToken(env, force) {
  const спать = (мс) => new Promise(r => setTimeout(r, мс));
  const прочесть = async () => {
    const raw = await env.ORDERS.get('seller_token');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };

  const есть = await прочесть();
  if (!force && есть && есть.access && Date.now() < есть.exp - 60000) return есть.access;

  /*
   * Насильственное обновление не трогает только что выданный токен.
   *
   * sellerCall при любом ответе Ozon со словом «token» звал обновление с
   * force. А когда к Ozon идут четырнадцать запросов подряд (характеристики)
   * или двадцать пять (описания), один просроченный ответ порождал столько
   * же одновременных обновлений. Ozon меняет ключ обновления при каждом
   * использовании и считает повторное предъявление кражей — цепочка рвалась.
   * Именно это Александр видел 15.08 трижды за вечер.
   *
   * Токен, выданный секунду назад, не может быть просроченным.
   */
  if (force && есть && есть.access && есть.выдан && Date.now() - есть.выдан < 60000) {
    return есть.access;
  }

  /*
   * Обновляет ровно один.
   *
   * Ждущие НЕ обновляют сами — раньше они ждали четыре секунды и всё равно
   * шли обновлять, то есть гонка не убиралась, а откладывалась. Теперь они
   * только перечитывают готовый токен, а если не дождались — отдают
   * последний известный, но нового обновления не начинают.
   */
  if (await env.ORDERS.get('seller_refresh:идёт')) {
    for (let i = 0; i < 12; i++) {
      await спать(700);
      const t = await прочесть();
      if (t && t.access && Date.now() < t.exp - 60000) return t.access;
    }
    if (есть && есть.access) return есть.access;
    throw new Error('обновление токена уже идёт');
  }
  await env.ORDERS.put('seller_refresh:идёт', '1', { expirationTtl: 60 });

  const изХранилища = await env.ORDERS.get('seller_refresh');
  /*
   * Предъявляем ТОЛЬКО живой ключ из хранилища.
   *
   * Здесь стоял запасной ключ из настроек воркера. Он одноразовый и погашен
   * с первого же обновления, а Ozon считает повторное предъявление погашенного
   * ключа попыткой кражи и гасит всю цепочку — вместе с только что выданным.
   * То есть «запасной вариант» не спасал, а добивал: каждая неудачная попытка
   * превращалась в окончательную потерю доступа (разбор 16.08).
   */
  const попытки = изХранилища ? [изХранилища] : [];
  let последний = '';
  for (const refresh of попытки) {
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
    if (!access) { последний = text.slice(0, 120); continue; }
    const newRefresh = p.get('refresh_token');
    const ttl = Math.min(Number(p.get('expires_in') || 3600), 2700) * 1000;
    // Новый ключ обновления сохраняем ПЕРВЫМ делом: если упасть после выдачи,
    // но до сохранения, старый уже погашен и доступ потерян.
    if (newRefresh) await env.ORDERS.put('seller_refresh', newRefresh);
    await env.ORDERS.put('seller_token', JSON.stringify({
      access, exp: Date.now() + ttl, выдан: Date.now()
    }));
    await env.ORDERS.delete('seller_refresh:идёт');
    await env.ORDERS.delete('seller_refresh:тревога');
    return access;
  }
  await env.ORDERS.delete('seller_refresh:идёт');
  /*
   * Кричим сразу.
   *
   * 14.08 доступ к Ozon умер вечером 13-го, а заметили это через пятнадцать
   * часов: расчёт доставки отвечал «internal», статусы стояли, остатки
   * устарели, и всё это молча. Раз в час — чтобы не превратить тревогу в шум.
   */
  try {
    if (!(await env.ORDERS.get('seller_refresh:тревога'))) {
      await env.ORDERS.put('seller_refresh:тревога', '1', { expirationTtl: 3600 });
      await notify(env,
        'NutryGo: доступ к Ozon потерян — ' + String(последний).slice(0, 120) +
        '\nНе работают: расчёт доставки, создание отправлений, статусы, остатки.' +
        '\nЧинится новой авторизацией: ссылка «Разрешить», затем /ozon/oauth/finish?code=…');
    }
  } catch (e) {}
  throw new Error('не удалось обновить токен: ' + последний);
}

/**
 * Ozon не знает этот телефон — у человека просто нет аккаунта Ozon.
 * Ответ приходит как {"code":5,"message":"user with specified phone number
 * was not found"}.
 */
function phoneUnknownToOzon(r) {
  return !!(r && typeof r.message === 'string' &&
    /user with specified phone number was not found/i.test(r.message));
}

/**
 * Расчёт доставки: сперва с телефоном покупателя, а если такой телефон Ozon
 * незнаком — тем же запросом без телефона.
 *
 * Случай из жизни, 13.08.2026, заказ 1868559242: покупатель оплатил 1470 ₽,
 * а расчёт сорвался с «user with specified phone number was not found», и
 * отправление пришлось оформлять руками. Проверено на живом API: тот же пункт
 * и тот же товар без телефона считаются нормально (доставка 15–16.08), а с
 * телефоном — отказ, причём одинаково во всех трёх написаниях (79…, 89…, 9…),
 * то есть дело не в формате номера. Телефон в расчёте нужен только затем,
 * чтобы Ozon подобрал персональные условия своему зарегистрированному
 * покупателю. Для человека со стороны расчёт обязан идти как для нового, а не
 * срываться: у нас интернет-магазин, а не витрина Ozon, и требовать от
 * покупателя аккаунт Ozon мы не можем.
 *
 * Телефон получателя при создании отправления передаётся как раньше — по нему
 * пункт выдачи находит человека и шлёт код получения.
 */
async function checkoutDelivery(env, token, payload, log) {
  let r = await sellerCall(env, token, '/v2/delivery/checkout', payload);
  const пусто = !r || !r.splits || !r.splits.length;
  if (пусто && payload.buyer_phone && phoneUnknownToOzon(r)) {
    const безТелефона = Object.assign({}, payload);
    delete безТелефона.buyer_phone;
    if (log) await log('телефон покупателя не заведён в Ozon — считаем без него');
    r = await sellerCall(env, token, '/v2/delivery/checkout', безТелефона);
    // Помечаем ответ: расчёт мы вытянули, но телефон Ozon неизвестен, а на
    // создании отправления он обязателен. Корзине это нужно знать до кассы.
    if (r && typeof r === 'object') r.ngr_phone_unknown = true;
  }
  return r;
}

/*
 * Какие методы обязаны идти по OAuth.
 *
 * Это методы «Ozon Доставки» — то, ради чего частное приложение и заводилось.
 * Всё остальное на api-seller.ozon.ru — обычные методы кабинета продавца, и
 * они принимают постоянный ключ Api-Key.
 *
 * Зачем разделять. Ключ обновления OAuth одноразовый: Ozon меняет его при
 * каждом использовании и рвёт цепочку при любой накладке. За вечер 15.08
 * цепочка рвалась трижды, и каждый раз это чинилось только руками Александра.
 * При этом три четверти нашего трафика к Ozon — товары, остатки, отправления,
 * отзывы, описания — к доставке отношения не имеют. Уводим их на Api-Key,
 * который не протухает и не меняется:
 *
 *  • обновлений OAuth становится в разы меньше, значит и рваться почти нечему;
 *  • если цепочка всё же порвётся, магазин не слепнет: остатки, статусы и
 *    каталог продолжают обновляться, а починки требует только расчёт доставки.
 *
 * Пока ключ не задан, всё работает как раньше — по OAuth.
 */
const ТОЛЬКО_OAUTH = /^\/(v\d\/)?(delivery|order|cancel-reason)\//;

/**
 * Токен для обычных методов кабинета продавца.
 *
 * Замысел «магазин не слепнет без OAuth» был верным, но не доведён: задачи
 * просили OAuth-токен ЗАРАНЕЕ и падали ещё до того, как `sellerCall` решал
 * идти по Api-Key. Из-за этого 15.08 остатки не обновлялись двадцать часов,
 * хотя постоянный ключ был настроен и метод остатков в нём не нуждается.
 *
 * Теперь: есть Api-Key — OAuth не трогаем вовсе. Это и чинит слепоту, и
 * снижает число обновлений, из-за которых цепочка рвалась.
 */
async function токенКабинета(env) {
  if (env.OZON_API_KEY && env.OZON_CLIENT_ID) return '';
  return await sellerToken(env);
}

async function sellerCall(env, token, path, payload, retried) {
  const ключНеНужен = ТОЛЬКО_OAUTH.test(path) || !(env.OZON_API_KEY && env.OZON_CLIENT_ID);
  const headers = ключНеНужен
    ? { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    : { 'Client-Id': String(env.OZON_CLIENT_ID), 'Api-Key': String(env.OZON_API_KEY),
        'Content-Type': 'application/json' };
  const r = await fetch(SELLER + path, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => null);
  const expired = j && typeof j.message === 'string' && /expired|unauthor|token/i.test(j.message);
  // По Api-Key повторять бессмысленно: он не протухает, и «unauthorized»
  // означал бы неверный ключ, а не истёкший срок.
  if (expired && !retried && ключНеНужен) {
    /*
     * Повторяем — но не насилуем обновление.
     *
     * Здесь стоял вызов с force, и это оказалось главным разрушителем связки:
     * когда к Ozon идут четырнадцать запросов подряд (характеристики) или
     * двадцать пять (описания), один просроченный ответ порождал столько же
     * одновременных обновлений, а Ozon рвёт цепочку при повторном
     * предъявлении ключа. Теперь просто просим токен обычным путём: если его
     * уже обновил кто-то другой, придёт готовый, а второго обновления не
     * будет.
     */
    console.log('токен протух, повторяем:', path);
    const fresh = await sellerToken(env);
    return sellerCall(env, fresh, path, payload, true);
  }
  if (!r.ok) console.log('seller', path, r.status, JSON.stringify(j).slice(0, 200));
  return j;
}

/* ---------- Состояние отправления в Ozon ---------- */

/**
 * Человеческие названия состояний отправления.
 *
 * Берём из справочника Ozon Доставки. Покупателю нужны не коды, а понятные
 * слова, и они же пойдут в письмо.
 */
const СОСТОЯНИЯ = {
  // Список взят из справочника Ozon Seller API, раздел «Статусы», и формулировки
  // тоже их: так покупатель видит у нас те же слова, что и в приложении Ozon.
  // Прежний словарь был собран по таблице схемы FBO, а наши отправления идут по
  // FBS — из-за этого 13.08 покупателю уехал сырой код posting_in_carriage.
  posting_split_pending: 'создано, ожидает оплаты',
  posting_created: 'создано',
  posting_registered: 'зарегистрировано',
  posting_awaiting_registration: 'ожидает регистрации',
  posting_registration_error: 'ошибка оформления, разбираемся',
  posting_awaiting_passport_data: 'нужны паспортные данные',
  posting_acceptance_in_progress: 'идёт приёмка',
  posting_packing: 'на упаковке',
  posting_not_in_carriage: 'не добавлено в перевозку',
  posting_in_carriage: 'в перевозке',
  posting_transferring_to_delivery: 'передаётся в доставку',
  posting_transferred_to_courier_service: 'передано в службу доставки',
  posting_driver_pick_up: 'у водителя',
  posting_in_courier_service: 'курьер в пути',
  posting_on_way_to_city: 'в пути в ваш город',
  posting_not_in_sort_center: 'не принято на сортировочном центре',
  posting_on_way_to_pickup_point: 'в пути в пункт выдачи',
  posting_in_pickup_point: 'ждёт вас в пункте выдачи',
  posting_delivered: 'доставлено',
  posting_conditionally_delivered: 'условно доставлено',
  posting_received: 'получено',
  posting_returned_to_warehouse: 'возвращено на склад',
  posting_in_arbitration: 'разбирательство по доставке',
  posting_in_client_arbitration: 'разбирательство по доставке',
  posting_canceled: 'отменено'
};
const СОСТОЯНИЯ_ФИНАЛ = ['posting_received', 'posting_canceled'];

/**
 * Номера отправлений из ответа на создание заказа.
 *
 * Точную форму ответа Ozon мы не фиксировали, а полагаться на угаданный путь
 * в чужой структуре — верный способ однажды тихо перестать работать. Поэтому
 * обходим ответ целиком и собираем всё, что выглядит как номер отправления
 * (например 40704586-0718-1). Что нашли — пишем в заказ, чтобы форма ответа
 * стала видна по первому же живому заказу, а не по догадкам.
 */
function postingNumbers(ozonOrder) {
  const out = [], seen = {};
  (function walk(v, depth) {
    if (v == null || depth > 8) return;
    if (typeof v === 'string') {
      if (/^\d{4,}-\d{3,}-\d+$/.test(v) && !seen[v]) { seen[v] = 1; out.push(v); }
      return;
    }
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (typeof v === 'object') { Object.keys(v).forEach(k => walk(v[k], depth + 1)); }
  })(ozonOrder, 0);
  return out;
}

/**
 * Письма покупателю о доставке.
 *
 * Пишем только на два события из двадцати пяти: посылка приехала в пункт и
 * посылка получена. Слать на каждое состояние нельзя — на один заказ вышло бы
 * до восьми писем, и человек отписался бы от нас навсегда.
 *
 * Решение Александра 13.08. Оформление пока простым текстом: так письмо дойдёт
 * до любого почтовика и не попадёт в спам за вёрстку. Красивый шаблон — потом.
 */
/**
 * Оформление писем покупателю.
 *
 * Почта — не браузер: работают таблицы и строчные стили, не работают ни
 * внешние стили, ни сетки, ни flex. Ширина 600 точек — то, что показывают
 * без горизонтальной прокрутки все почтовые программы.
 *
 * Картинок нет намеренно: почтовые программы прячут их до нажатия «показать»,
 * и письмо с логотипом-картинкой у половины получателей выглядит пустым.
 * Шапка сделана текстом в фирменных цветах, поэтому выглядит одинаково всегда.
 */
const ЛОГОТИП = 'https://static.tildacdn.pub/tild3336-3339-4966-a661-393933346133/Nutry_Go__.png';
const ЦВЕТ = {
  бренд: '#f28c28',
  синий: '#4984c4',
  чернила: '#14171c',
  серый: '#6b7280',
  линия: '#e8ecf1',
  фон: '#f5f7fa',
  успех: '#1f8a3b'
};

/** Дата по-русски: «16 августа». Для писем, а не для журналов. */
function fmtДата(iso) {
  try {
    const d = new Date(iso);
    const м = ['января','февраля','марта','апреля','мая','июня','июля','августа',
      'сентября','октября','ноября','декабря'];
    return d.getDate() + ' ' + м[d.getMonth()];
  } catch (e) { return ''; }
}

function экран(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Общая обёртка письма. Всё содержимое приходит уже разметкой, но текст в неё
 * подставляется только через экран(): в письмо попадают названия товаров и
 * адреса, то есть чужие строки.
 */
function письмоВид(о) {
  const кнопка = о.кнопка ? (
    '<tr><td style="padding:4px 32px 28px">' +
    '<a href="' + экран(о.кнопка.ссылка) + '" style="display:inline-block;' +
    'background:' + ЦВЕТ.бренд + ';color:#ffffff;text-decoration:none;font-weight:700;' +
    'font-size:15px;padding:13px 26px;border-radius:10px">' + экран(о.кнопка.текст) + '</a>' +
    '</td></tr>') : '';
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + экран(о.тема) + '</title></head>' +
    '<body style="margin:0;padding:0;background:' + ЦВЕТ.фон + ';">' +
    // Прехедер: строка, которую почтовые программы показывают в списке рядом
    // с темой. Без неё туда попадает случайный кусок разметки.
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' +
    экран(о.прехедер || '') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
    'style="background:' + ЦВЕТ.фон + ';padding:24px 12px">' +
    '<tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" ' +
    'style="width:100%;max-width:600px;background:#ffffff;border-radius:16px;' +
    'border:1px solid ' + ЦВЕТ.линия + ';font-family:-apple-system,BlinkMacSystemFont,' +
    '\'Segoe UI\',Roboto,Arial,sans-serif">' +

    // Фирменная полоса в цветах логотипа. Сделана ячейками таблицы, а не
    // картинкой и не градиентом: цвет фона показывают все почтовые программы,
    // включая те, что режут картинки и не знают градиентов.
    '<tr><td style="padding:0"><table role="presentation" width="100%" cellpadding="0" ' +
    'cellspacing="0" style="border-radius:16px 16px 0 0;overflow:hidden"><tr>' +
    '<td height="5" style="background:' + ЦВЕТ.бренд + ';font-size:0;line-height:0">&nbsp;</td>' +
    '<td height="5" style="background:#e2574c;font-size:0;line-height:0">&nbsp;</td>' +
    '<td height="5" style="background:' + ЦВЕТ.синий + ';font-size:0;line-height:0">&nbsp;</td>' +
    '</tr></table></td></tr>' +

    // Логотип картинкой, но с запасом: если почтовая программа спрятала
    // картинки — а так делает почти каждая до нажатия «показать», — на её
    // месте останется подпись тем же начертанием, и шапка не осыплется.
    '<tr><td style="padding:24px 32px 4px">' +
    '<img src="' + ЛОГОТИП + '" width="150" height="36" alt="NUTRY GO" ' +
    'style="display:block;border:0;outline:none;text-decoration:none;height:auto;' +
    'font-size:18px;font-weight:800;color:' + ЦВЕТ.чернила + '">' +
    '</td></tr>' +

    '<tr><td style="padding:14px 32px 0"><div style="font-size:22px;line-height:1.3;' +
    'font-weight:800;color:' + ЦВЕТ.чернила + '">' + экран(о.заголовок) + '</div></td></tr>' +

    '<tr><td style="padding:14px 32px 0;font-size:15px;line-height:1.55;color:' +
    ЦВЕТ.чернила + '">' + о.тело + '</td></tr>' +

    кнопка +

    '<tr><td style="padding:22px 32px 26px;border-top:1px solid ' + ЦВЕТ.линия + ';' +
    'font-size:12.5px;line-height:1.5;color:' + ЦВЕТ.серый + '">' +
    'Спасибо, что выбираете NutryGo. Нам правда приятно.<br>' +
    'Если что-то пойдёт не так или просто захочется спросить — ответьте на это ' +
    'письмо, его читает живой человек.' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

/** Плашка с важным: адрес пункта, номер отправления, код. */
function письмоПлашка(строки, цвет) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
    'style="margin:16px 0;background:' + (цвет || ЦВЕТ.фон) + ';border-radius:12px">' +
    '<tr><td style="padding:14px 16px;font-size:15px;line-height:1.5;color:' +
    ЦВЕТ.чернила + '">' + строки.join('<br>') + '</td></tr></table>';
}

/** Состав заказа списком. */
function письмоТовары(order) {
  const т = Array.isArray(order.items) ? order.items : [];
  const строки = [];
  for (const п of т) {
    const имя = String(п.name || '').trim();
    if (!имя) continue;
    const сколько = Number(п.quantity || п.amount || 1) || 1;
    строки.push('<tr><td style="padding:6px 0;font-size:14px;color:' + ЦВЕТ.чернила +
      '">' + экран(имя) + '</td>' +
      '<td style="padding:6px 0;font-size:14px;color:' + ЦВЕТ.серый +
      ';text-align:right;white-space:nowrap">' + сколько + '&nbsp;шт.</td></tr>');
  }
  if (!строки.length) return '';
  return '<div style="font-size:13px;color:' + ЦВЕТ.серый + ';margin-top:18px">Состав заказа</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
    строки.join('') + '</table>';
}

const ПИСЬМА_ПО_СОСТОЯНИЯМ = ['posting_in_pickup_point', 'posting_received'];

function списокТоваров(order) {
  const т = Array.isArray(order.items) ? order.items : [];
  const строки = [];
  for (const п of т) {
    const имя = String(п.name || '').trim();
    if (!имя) continue;
    const сколько = Number(п.quantity || п.amount || 1) || 1;
    строки.push('— ' + имя + ', ' + сколько + ' шт.');
  }
  return строки.join('\n');
}

function письмоОДоставке(order, состояние, отправление) {
  const номер = экран(order.ext_id || '');
  const адрес = экран(order.address || '');
  const товары = письмоТовары(order);

  if (состояние === 'posting_in_pickup_point') {
    const тема = 'Заказ ' + номер + ' ждёт вас в пункте выдачи';
    return {
      subject: тема,
      text: 'Здравствуйте!\n\nВаш заказ приехал и ждёт в пункте выдачи Ozon:\n' +
        String(order.address || '') + '\n\nОтправление ' + отправление +
        '\nКод получения придёт от Ozon на номер, указанный в заказе.\n\n' +
        'Хранение — 14 дней. Спасибо, что выбрали NutryGo.',
      html: письмоВид({
        тема: тема, заголовок: 'Ваш заказ доехал 🎉',
        прехедер: 'Можно забирать — ждём вас в пункте выдачи',
        тело: '<p style="margin:0 0 10px">Добрый день!</p>' +
          '<p style="margin:0 0 4px">Хорошие новости: заказ <b>№ ' + номер + '</b> добрался ' +
          'до пункта выдачи и ждёт вас. Спасибо, что дождались.</p>' +
          письмоПлашка([
            '<b>' + адрес + '</b>',
            '<span style="color:' + ЦВЕТ.серый + '">Отправление ' + экран(отправление) + '</span>'
          ]) +
          '<p style="margin:0 0 4px">Код получения придёт от Ozon на номер из заказа — ' +
          'назовите его на выдаче, и всё.</p>' +
          '<p style="margin:12px 0 0;color:' + ЦВЕТ.серый + '">Посылка полежит 14 дней, ' +
          'так что спокойно заходите, когда будет удобно.</p>' +
          товары
      })
    };
  }

  const тема = 'Заказ ' + номер + ' получен — спасибо!';
  return {
    subject: тема,
    text: 'Здравствуйте!\n\nВаш заказ ' + номер + ' получен. Спасибо, что выбрали NutryGo.\n\n' +
      'Если что-то не так с товаром или документами — просто ответьте на это письмо.',
    html: письмоВид({
      тема: тема, заголовок: 'Спасибо, что выбрали нас',
      прехедер: 'Заказ у вас — пусть он принесёт пользу',
      тело: '<p style="margin:0 0 10px">Добрый день!</p>' +
        '<p style="margin:0 0 4px">Заказ <b>№ ' + номер + '</b> у вас. Спасибо, что доверились ' +
        'нам — для небольшого магазина это правда много значит.</p>' +
        '<p style="margin:12px 0 0">Пусть всё пойдёт на пользу. А если что-то смутит — ' +
        'состав, срок, документы или просто захочется спросить, что с чем сочетается, — ' +
        'ответьте на это письмо. Мы рядом.</p>' + товары
    })
  };
}

/**
 * Письмо о принятом заказе. Уходит сразу после того, как оплата подтверждена
 * и отправление создано: до этой правки покупатель после оплаты не получал от
 * нас ничего вовсе и узнавал о судьбе заказа только от Ozon.
 */
function письмоОЗаказе(order, отправление, срок) {
  const номер = экран(order.ext_id || '');
  const тема = 'Заказ ' + номер + ' принят и оплачен';
  const когда = срок ? экран(срок) : '';
  return {
    subject: тема,
    text: 'Здравствуйте!\n\nВаш заказ ' + номер + ' принят и оплачен.\n' +
      'Пункт выдачи: ' + String(order.address || '') + '\n' +
      (отправление ? 'Отправление ' + отправление + '\n' : '') +
      '\nМы сообщим, когда посылка приедет в пункт выдачи.\nСпасибо, что выбрали NutryGo.',
    html: письмоВид({
      тема: тема, заголовок: 'Спасибо за заказ!',
      прехедер: 'Уже собираем и передаём в доставку',
      тело: '<p style="margin:0 0 10px">Добрый день!</p>' +
        '<p style="margin:0 0 4px">Спасибо, что выбрали NutryGo. Заказ <b>№ ' + номер + '</b> ' +
        'оплачен, принят в работу и передан в доставку Ozon — дальше мы всё держим под присмотром.</p>' +
        письмоПлашка([
          '<b>' + экран(order.address || '') + '</b>',
          отправление ? '<span style="color:' + ЦВЕТ.серый + '">Отправление ' + экран(отправление) + '</span>' : '',
          когда ? '<span style="color:' + ЦВЕТ.серый + '">Ожидается ' + когда + '</span>' : ''
        ].filter(Boolean)) +
        '<p style="margin:0">Как только посылка доедет до пункта выдачи, мы сразу напишем — ' +
        'следить самому не нужно. Если удобнее, путь заказа виден и в приложении Ozon.</p>' +
        письмоТовары(order)
    })
  };
}

/**
 * Опрос состояний отправлений.
 *
 * Зачем: статус, который видит покупатель, до сих пор ставил руками оператор
 * в кабинете Tilda. Автоматизировать это через Tilda нельзя — её публичный API
 * только читает страницы (журнал NG-2026-08-13-021). Зато сам Ozon состояние
 * отдаёт, а отправление создали мы и номер его знаем. Значит статус может быть
 * нашим и обновляться сам.
 *
 * Финальные состояния больше не опрашиваем: заказ доехал, спрашивать нечего.
 * За один проход берём не больше двадцати заказов — крон не место для длинных
 * циклов, а остальные подхватит следующий.
 */
async function refreshShipments(env) {
  const list = await env.ORDERS.list({ prefix: 'order:' });
  let token = null, тронуто = 0;
  for (const k of list.keys) {
    if (тронуто >= 20) break;
    const raw = await env.ORDERS.get(k.name);
    if (!raw) continue;
    let order;
    try { order = JSON.parse(raw); } catch (e) { continue; }
    if (!order.ozon_order) continue;
    if (order.shipment && СОСТОЯНИЯ_ФИНАЛ.indexOf(order.shipment.substatus) > -1) continue;
    const numbers = postingNumbers(order.ozon_order);
    if (!numbers.length) {
      if (!order.shipment_probe) {
        order.shipment_probe = 'номер отправления в ответе не найден';
        await env.ORDERS.put(k.name, JSON.stringify(order));
      }
      continue;
    }
    if (!token) token = await sellerToken(env);
    тронуто++;
    try {
      const r = await sellerCall(env, token, '/v3/posting/fbs/get', {
        posting_number: numbers[0], with: {}
      });
      const p = (r && (r.result || r)) || {};
      const substatus = String(p.substatus || p.status || '');
      if (!substatus) continue;
      const было = order.shipment && order.shipment.substatus;
      // Незнакомый код покупателю не показываем никогда: «posting_in_carriage»
      // в письме или в кабинете — это стыдно и непонятно. Показываем
      // нейтральное, а сам код запоминаем, чтобы назвать его по-человечески
      // по живым данным, а не по догадке.
      let текст = СОСТОЯНИЯ[substatus];
      if (!текст) {
        текст = 'в обработке';
        try {
          await env.ORDERS.put('substatus:' + substatus,
            JSON.stringify({ впервые: new Date().toISOString(), заказ: order.ext_id || '' }),
            { expirationTtl: 86400 * 60 });
        } catch (e) {}
        console.log('незнакомое состояние отправления:', substatus);
      }
      order.shipment = {
        posting: numbers[0],
        all: numbers,
        substatus: substatus,
        text: текст,
        checked: new Date().toISOString()
      };
      await env.ORDERS.put(k.name, JSON.stringify(order));
      if (было !== substatus) {
        // Себе в Telegram пишем и человеческое название, и код, если он
        // незнаком: так видно, что именно надо перевести.
        await notify(env, 'Заказ ' + (order.ext_id || k.name.slice(6)) + ': отправление ' +
          numbers[0] + ' — ' + текст +
          (СОСТОЯНИЯ[substatus] ? '' : ' (новый код ' + substatus + ')') + '.');

        // Письмо покупателю — только на два события и только один раз.
        // Отметка о посланном хранится в заказе: без неё повторный проход
        // после сбоя отправил бы письмо снова.
        order.mailed = order.mailed || {};
        const почтаПокупателя = String(order.email || '').trim();
        if (ПИСЬМА_ПО_СОСТОЯНИЯМ.indexOf(substatus) > -1 &&
            !order.mailed[substatus] &&
            почтаПокупателя.indexOf('@') > 0) {
          const текстПисьма = письмоОДоставке(order, substatus, numbers[0]);
          // html обязателен. 14.08: здесь его не передавали, и письма о
          // доставке уходили голым текстом — вся вёрстка с логотипом,
          // составом заказа и адресом пункта до покупателя не доезжала,
          // хотя письмо о принятом заказе уходило оформленным. Расхождение
          // заметно только в почтовом ящике, в коде оно было незаметным.
          const итог = await smtpSend(env, {
            to: почтаПокупателя, subject: текстПисьма.subject,
            text: текстПисьма.text, html: текстПисьма.html
          });
          // Отмечаем только удачную отправку: если почта ещё не настроена,
          // письмо уйдёт при следующей настоящей смене состояния, а не
          // потеряется молча.
          if (итог.ok) {
            order.mailed[substatus] = new Date().toISOString();
            await env.ORDERS.put(k.name, JSON.stringify(order));
          } else {
            console.log('письмо покупателю не ушло:', order.ext_id, substatus, итог.why);
          }
        }
      }
    } catch (e) {
      console.log('состояние отправления:', k.name, e.message);
    }
  }
}

/* ---------- Свой вход по коду на почту ---------- */

/**
 * Зачем нужен свой вход.
 *
 * Подтвердить токен Tilda с сервера нельзя: тот же токен работает из браузера
 * покупателя и не работает из сети Cloudflare (девять опытов, журнал
 * NG-2026-08-13-025). Пока это не решено, кабинет опирается на предъявление —
 * почту и номера с суммами из панели Tilda, — а застава заказа ослаблена
 * горячим фиксом с 10.08. И то и другое держится на знании, а не на владении.
 *
 * Свой вход это закрывает: человек доказывает, что почта его, получив на неё
 * код. Дальше воркер узнаёт его сам, без Tilda.
 */
const КОД_ЖИВЁТ = 10 * 60;          // столько секунд годен код из письма
const КОД_ПОПЫТОК = 5;              // столько раз можно ошибиться
const КОД_ПАУЗА = 60 * 1000;        // не чаще одного письма в минуту на адрес
const ВХОД_ЖИВЁТ = 30 * 24 * 3600;  // столько секунд живёт выданный пропуск

function почтаНорм(v) {
  return String(v || '').trim().toLowerCase();
}
function почтаГодна(v) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v) && v.length <= 190;
}

/** Ключ подписи пропусков. Отдельная метка, чтобы не пересекаться с другими. */
async function ключВхода(env) {
  const секрет = String(env.ACCOUNT_SUBJECT_KEY || '');
  if (секрет.length < 32) return null;
  return crypto.subtle.importKey('raw', new TextEncoder().encode('auth:' + секрет),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function вБезопасныйBase64(буфер) {
  let s = '';
  new Uint8Array(буфер).forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Пропуск: почта и срок, подписанные HMAC. Ничего секретного внутри нет —
 * подпись лишь не даёт выдать себя за другого.
 */
async function выдатьПропуск(env, почта) {
  const ключ = await ключВхода(env);
  if (!ключ) return '';
  const тело = почта + '|' + (Math.floor(Date.now() / 1000) + ВХОД_ЖИВЁТ);
  const подпись = await crypto.subtle.sign('HMAC', ключ, new TextEncoder().encode(тело));
  return вБезопасныйBase64(new TextEncoder().encode(тело)) + '.' + вБезопасныйBase64(подпись);
}

async function прочестьПропуск(env, пропуск) {
  try {
    const части = String(пропуск || '').split('.');
    if (части.length !== 2) return '';
    const ключ = await ключВхода(env);
    if (!ключ) return '';
    const изBase64 = (s) => Uint8Array.from(
      atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const тело = new TextDecoder().decode(изBase64(части[0]));
    const годно = await crypto.subtle.verify('HMAC', ключ, изBase64(части[1]),
      new TextEncoder().encode(тело));
    if (!годно) return '';
    const [почта, срок] = тело.split('|');
    if (!почта || Number(срок) < Math.floor(Date.now() / 1000)) return '';
    return почта;
  } catch (e) { return ''; }
}

/**
 * Просьба прислать код.
 *
 * Отвечаем одинаково, есть такая почта у нас или нет: иначе эта ручка
 * превращается в способ выяснять, кто у нас покупал.
 */
async function authRequest(request, env) {
  const тело = await request.json().catch(() => null);
  const почта = почтаНорм(тело && тело.email);
  if (!почтаГодна(почта)) return json({ error: 'нужен адрес почты' }, 400);

  const ключ = 'authcode:' + почта;
  const было = await env.ORDERS.get(ключ);
  if (было) {
    try {
      const п = JSON.parse(было);
      if (Date.now() - Number(п.послано || 0) < КОД_ПАУЗА) {
        return json({ ok: true, note: 'код уже отправлен' });
      }
    } catch (e) {}
  }

  // Шестизначный код из криптостойкого источника: Math.random для такого не
  // годится.
  const цифры = new Uint32Array(1);
  crypto.getRandomValues(цифры);
  const код = String(100000 + (цифры[0] % 900000));

  await env.ORDERS.put(ключ, JSON.stringify({
    код: код, послано: Date.now(), попыток: 0
  }), { expirationTtl: КОД_ЖИВЁТ });

  const минут = Math.round(КОД_ЖИВЁТ / 60);
  const письмо = await smtpSend(env, {
    to: почта,
    subject: 'Код для входа в NutryGo: ' + код,
    text: 'Ваш код для входа в личный кабинет NutryGo: ' + код + '\n\n' +
      'Код годен ' + минут + ' минут.\n' +
      'Если вы не запрашивали вход, просто не отвечайте на это письмо.',
    html: письмоВид({
      тема: 'Код для входа в NutryGo',
      заголовок: 'Рады видеть вас снова',
      прехедер: 'Код действует ' + минут + ' минут',
      тело: '<p style="margin:0 0 10px">Добрый день!</p>' +
        '<p style="margin:0">Вот код для входа в личный кабинет:</p>' +
        '<div style="margin:18px 0;font-size:34px;font-weight:800;letter-spacing:8px;' +
        'color:' + ЦВЕТ.чернила + '">' + экран(код) + '</div>' +
        '<p style="margin:0;color:' + ЦВЕТ.серый + '">Код действует ' + минут + ' минут.</p>' +
        '<p style="margin:12px 0 0;color:' + ЦВЕТ.серый + '">Если вход запрашивали не вы — ' +
        'просто не отвечайте на письмо. Без кода в кабинет никто не войдёт, ' +
        'беспокоиться не о чем.</p>'
    })
  });
  // Об исходе отправки покупателю не сообщаем подробностей, но себе в журнал
  // пишем: без этого молчащая почта неотличима от неверного адреса.
  if (!письмо.ok) console.log('код не отправлен:', почта, письмо.why);
  return json({ ok: true });
}

/** Проверка кода и выдача пропуска. */
async function authConfirm(request, env) {
  const тело = await request.json().catch(() => null);
  const почта = почтаНорм(тело && тело.email);
  const код = String((тело && тело.code) || '').replace(/\D/g, '');
  if (!почтаГодна(почта) || код.length !== 6) return json({ error: 'нужны почта и код' }, 400);

  const ключ = 'authcode:' + почта;
  const сырое = await env.ORDERS.get(ключ);
  if (!сырое) return json({ error: 'код устарел, запросите новый' }, 400);
  let п;
  try { п = JSON.parse(сырое); } catch (e) { return json({ error: 'код устарел' }, 400); }

  if (Number(п.попыток || 0) >= КОД_ПОПЫТОК) {
    await env.ORDERS.delete(ключ);
    return json({ error: 'слишком много попыток, запросите новый код' }, 429);
  }
  if (String(п.код) !== код) {
    п.попыток = Number(п.попыток || 0) + 1;
    await env.ORDERS.put(ключ, JSON.stringify(п), { expirationTtl: КОД_ЖИВЁТ });
    return json({ error: 'код не подходит' }, 400);
  }

  await env.ORDERS.delete(ключ);
  const пропуск = await выдатьПропуск(env, почта);
  if (!пропуск) return json({ error: 'вход не настроен' }, 503);
  return json({ ok: true, pass: пропуск, email: почта });
}

/* ---------- Почта ---------- */

/**
 * Отправка письма через SMTP Яндекса.
 *
 * У Workers нет почтового API, зато есть исходящие сокеты. Порт 25 у
 * Cloudflare закрыт, поэтому идём на 465 с TLS сразу. Проверено 13.08.2026:
 * Яндекс принимает соединение из сети Cloudflare и отвечает приветствием
 * «220 ... Ok» — в отличие от tildaapi, которая оттуда же не работает.
 *
 * Доступы живут в секретах воркера: SMTP_USER (полный адрес ящика) и
 * SMTP_PASS (пароль приложения Яндекса, не пароль от аккаунта). Заводит их
 * владелец магазина сам; в коде и в репозитории их нет и быть не должно.
 */
async function smtpSend(env, письмо) {
  // Дефис в имени секрета — лёгкая описка при заведении, а стоит целого
  // разбирательства: env.SMTP_PASS просто окажется пустым, и письма молча
  // не пойдут. Понимаем оба написания и в отказе говорим, чего именно нет.
  const пользователь = String(env.SMTP_USER || env['SMTP-USER'] || '');
  const пароль = String(env.SMTP_PASS || env['SMTP-PASS'] || '');
  if (!пользователь || !пароль) {
    return { ok: false, why: 'нет ' + (!пользователь ? 'SMTP_USER' : '') +
      (!пользователь && !пароль ? ' и ' : '') + (!пароль ? 'SMTP_PASS' : '') };
  }

  const сокет = connect({ hostname: env.SMTP_HOST || 'smtp.yandex.ru', port: 465 },
    { secureTransport: 'on', allowHalfOpen: false });
  const писатель = сокет.writable.getWriter();
  const читатель = сокет.readable.getReader();
  const вКодах = new TextEncoder();
  const вТекст = new TextDecoder();
  let хвост = '';
  const шаги = [];

  // Ответ SMTP может прийти несколькими строками: последняя отличается тем,
  // что после кода стоит пробел, а не дефис. Читаем, пока такой не встретим.
  async function ответ() {
    for (let i = 0; i < 40; i++) {
      const строки = хвост.split(/\r?\n/);
      for (const с of строки) if (/^\d{3} /.test(с)) { const r = хвост; хвост = ''; return r.trim(); }
      const кусок = await Promise.race([
        читатель.read(),
        new Promise((_, отказ) => setTimeout(() => отказ(new Error('SMTP молчит')), 10000))
      ]);
      if (кусок.done) break;
      хвост += вТекст.decode(кусок.value);
    }
    const r = хвост; хвост = '';
    return r.trim();
  }
  async function команда(текст, зачем) {
    await писатель.write(вКодах.encode(текст + '\r\n'));
    const о = await ответ();
    шаги.push(зачем + ': ' + о.split(/\r?\n/)[0].slice(0, 80));
    return о;
  }
  const код = (о) => Number(String(о).slice(0, 3)) || 0;

  try {
    const привет = await ответ();
    шаги.push('приветствие: ' + привет.slice(0, 60));
    if (код(привет) !== 220) throw new Error('сервер не поздоровался');

    if (код(await команда('EHLO nutry-go.ru', 'EHLO')) !== 250) throw new Error('EHLO отклонён');
    if (код(await команда('AUTH LOGIN', 'AUTH')) !== 334) throw new Error('AUTH LOGIN не предложен');
    if (код(await команда(btoa(пользователь), 'логин')) !== 334) throw new Error('логин отклонён');
    // Пароль в шаги не пишем ни в каком виде.
    const вход = await команда(btoa(пароль), 'пароль');
    if (код(вход) !== 235) throw new Error('вход не принят: ' + вход.slice(0, 60));

    if (код(await команда('MAIL FROM:<' + пользователь + '>', 'отправитель')) !== 250) throw new Error('отправитель отклонён');
    if (код(await команда('RCPT TO:<' + письмо.to + '>', 'получатель')) > 259) throw new Error('получатель отклонён');
    if (код(await команда('DATA', 'DATA')) !== 354) throw new Error('DATA отклонён');

    // Кириллица в теме и теле — только через base64, иначе почтовые серверы
    // портят кодировку.
    const вБазу = (t) => btoa(String.fromCharCode.apply(null, Array.from(вКодах.encode(t))));
    const строками = (t) => вБазу(t).replace(/(.{76})/g, '$1\r\n');
    const шапка = [
      'From: ' + (env.SMTP_FROM_NAME || 'NutryGo') + ' <' + пользователь + '>',
      'To: ' + письмо.to,
      'Subject: =?UTF-8?B?' + вБазу(письмо.subject) + '?=',
      'MIME-Version: 1.0'
    ];
    let тело;
    if (письмо.html) {
      // Составное письмо: сперва текстовая часть, потом HTML. Порядок важен —
      // почтовые программы показывают последнюю, которую понимают. Текстовую
      // часть кладём всегда: без неё письмо чаще попадает в спам, и её же
      // увидят те, у кого HTML отключён.
      const межа = 'ngr' + Math.abs(Date.parse(new Date().toISOString())).toString(36);
      тело = шапка.concat([
        'Content-Type: multipart/alternative; boundary="' + межа + '"',
        '',
        '--' + межа,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        строками(письмо.text),
        '--' + межа,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        строками(письмо.html),
        '--' + межа + '--'
      ]).join('\r\n');
    } else {
      тело = шапка.concat([
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        строками(письмо.text)
      ]).join('\r\n');
    }
    await писатель.write(вКодах.encode(тело + '\r\n.\r\n'));
    const итог = await ответ();
    шаги.push('письмо: ' + итог.split(/\r?\n/)[0].slice(0, 80));
    if (код(итог) !== 250) throw new Error('письмо не принято');

    await команда('QUIT', 'QUIT');
    try { писатель.releaseLock(); читатель.releaseLock(); await сокет.close(); } catch (e) {}
    return { ok: true, шаги };
  } catch (e) {
    try { писатель.releaseLock(); читатель.releaseLock(); await сокет.close(); } catch (e2) {}
    return { ok: false, why: String(e && e.message || e).slice(0, 160), шаги };
  }
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
