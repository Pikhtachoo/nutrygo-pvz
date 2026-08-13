/**
 * Выбор пункта выдачи Ozon в корзине nutry-go.ru.
 *
 * Как это работает для покупателя: вводит город (или жмёт «Рядом со мной») →
 * видит карту и список ближайших пунктов → выбирает точку на карте или в
 * списке → в заказ подставляется адрес с номером пункта, а рядом появляется
 * реальный срок доставки Ozon для этого пункта.
 *
 * Данные о пунктах — суточный справочник (build-pvz.ps1), поэтому корзина
 * открывается мгновенно и не зависит от доступности API Ozon. Срок доставки
 * спрашивается у интегратора уже после выбора точки.
 *
 * Карта — бесплатная схема без ключей и лимитов, на библиотеке OpenLayers.
 */
(function () {
  'use strict';

  var BASE_LIB = 'https://pikhtachoo.github.io/nutrygo-pvz';
  var BASE = window.NG_PVZ_BASE || BASE_LIB;
  var API = window.NG_INTEGRATOR_BASE || 'https://nutrygo-integrator.pikhtovnikov-alieksandr.workers.dev';
  // Библиотека карты лежит рядом со справочником пунктов — на адресе, который
  // открывается в России без VPN. Меньше внешних доменов, меньше поводов
  // карте не загрузиться у покупателя.
  var MAPLIB_CSS = BASE_LIB + '/js/ol/ol.css';
  var MAPLIB_JS = BASE_LIB + '/js/ol/ol.js';
  var TILES = 'https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

  var CITY_FIELD = 'city';
  var ADDR_FIELD = 'address';
  var TYPE_FIELD = 'delivery_type';
  var MAX_ON_MAP = 300;      // столько точек рисуем в видимой области
  var MAX_IN_LIST = 40;

  var cities = null;
  var mapLibLoading = null;

  var css = document.createElement('style');
  css.textContent =
    '.ngpvz{margin:10px 0}' +
    '.ngpvz__actions{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}' +
    '.ngpvz__geo,.ngpvz__maptoggle{border:1px solid #e2e2e2;background:#fff;border-radius:10px;padding:9px 14px;font-size:14px;cursor:pointer;color:#222}' +
    '.ngpvz__geo:hover,.ngpvz__maptoggle:hover{background:#f6f6f6}' +
    '.ngpvz__count{font-size:13px;color:#777}' +
    '.ngpvz__search{width:100%;box-sizing:border-box;padding:11px 14px;border:1px solid #ddd;border-radius:12px;font-size:15px;margin-top:8px;font-family:inherit}' +
    '.ngpvz__map{height:300px;border:1px solid #e6e6e6;border-radius:14px;margin-top:8px;overflow:hidden;display:none}' +
    '.ngpvz_map .ngpvz__map{display:block}' +
    // подпись карты держим компактной: сама библиотека логотипов не рисует
    '.ol-attribution{font-size:11px}.ol-attribution ul{color:#666}' +
    '.ngpvz__list{display:none;max-height:260px;overflow-y:auto;border:1px solid #e6e6e6;border-radius:14px;margin-top:8px;background:#fff;-webkit-overflow-scrolling:touch}' +
    '.ngpvz_open .ngpvz__list{display:block}' +
    '.ngpvz_open .ngpvz__search{display:block}' +
    '.ngpvz__item{display:block;width:100%;text-align:left;background:#fff;border:0;border-bottom:1px solid #f0f0f0;padding:11px 14px;cursor:pointer;font-size:14px;font-family:inherit}' +
    '.ngpvz__item:hover,.ngpvz__item:focus{background:#fdf6ec}' +
    '.ngpvz__addr{display:block;color:#1a1a1a;font-weight:600;line-height:1.3}' +
    '.ngpvz__meta{display:block;color:#8a8a8a;font-size:12px;margin-top:3px}' +
    '.ngpvz__empty{padding:14px;color:#888;font-size:14px}' +
    '.ngpvz__chosen{margin-top:8px;padding:11px 14px;border:1px solid #dcefc8;background:#f6faf1;border-radius:12px;font-size:14px;line-height:1.45;display:none}' +
    '.ngpvz_chosen .ngpvz__chosen{display:block}' +
    '.ngpvz__chosen b{color:#1f8a3b}' +
    '.ngpvz__change{background:none;border:0;color:#f28c28;cursor:pointer;padding:0;font-size:13px;font-family:inherit;text-decoration:underline}' +
    '@media (max-width:600px){' +
      '.ngpvz__actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:stretch}' +
      '.ngpvz__geo,.ngpvz__maptoggle{min-width:0;width:100%;min-height:44px;box-sizing:border-box;padding:10px 8px;font-size:16px;line-height:1.25;white-space:normal;overflow-wrap:anywhere}' +
      '.ngpvz__count{grid-column:1/-1}' +
      '.ngpvz__search{font-size:16px}' +
      '.ngpvz__map{height:240px}.ngpvz__list{max-height:220px}' +
    '}';
  document.head.appendChild(css);

  function get(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function norm(s) {
    return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  }

  function dist(lat1, lon1, lat2, lon2) {
    var kx = Math.cos(lat1 * Math.PI / 180) * 111.3;
    var dx = (lon1 - lon2) * kx, dy = (lat1 - lat2) * 111.3;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function loadCities() {
    if (cities) return Promise.resolve(cities);
    return get(BASE + '/cities.json').then(function (m) {
      cities = m.list || [];
      cities.forEach(function (c) { c._n = norm(c.city); });
      return cities;
    });
  }

  function findCity(name) {
    var n = norm(name);
    if (!n || !cities) return null;
    var exact = cities.filter(function (c) { return c._n === n; });
    if (exact.length) return exact.sort(function (a, b) { return b.count - a.count; })[0];
    var starts = cities.filter(function (c) { return c._n.indexOf(n) === 0; });
    if (starts.length) return starts.sort(function (a, b) { return b.count - a.count; })[0];
    return null;
  }

  function nearestCity(lat, lon) {
    var best = null, bestD = 1e9;
    (cities || []).forEach(function (c) {
      if (typeof c.y !== 'number') return;
      var d = dist(lat, lon, c.y, c.x);
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }

  /**
   * Библиотека карты — OpenLayers (европейский проект).
   *
   * Раньше использовался Leaflet, но он украинского происхождения и рисует
   * в подписи под картой украинский флаг прямо из своего кода. Для
   * российского магазина это неуместно, поэтому библиотека заменена целиком,
   * а не просто спрятан значок.
   */
  function removeMapLibTags() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ngpvz-maplib="1"]'), function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  function loadMapLib() {
    if (window.ol && window.ol.Map) return Promise.resolve();
    if (mapLibLoading) return mapLibLoading;
    removeMapLibTags();
    mapLibLoading = new Promise(function (res, rej) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = MAPLIB_CSS;
      link.setAttribute('data-ngpvz-maplib', '1');
      document.head.appendChild(link);
      var js = document.createElement('script');
      js.src = MAPLIB_JS;
      js.setAttribute('data-ngpvz-maplib', '1');
      var timer = window.setTimeout(function () { rej(new Error('map lib timeout')); }, 15000);
      js.onload = function () { window.clearTimeout(timer); res(); };
      js.onerror = function () { window.clearTimeout(timer); rej(new Error('map lib failed')); };
      document.head.appendChild(js);
    }).then(function () {
      if (!window.ol || !window.ol.Map) throw new Error('map lib did not initialize');
    }).catch(function (error) {
      mapLibLoading = null;
      removeMapLibTags();
      throw error;
    });
    return mapLibLoading;
  }

  function hoursText(p) { return p.h ? p.h.replace('-', '–') : ''; }
  function kindText(p) { return p.p ? 'Постамат Ozon' : 'Пункт выдачи Ozon'; }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var m = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    return d.getDate() + ' ' + m[d.getMonth()];
  }

  /** Что лежит в корзине Tilda — нужно, чтобы спросить срок доставки. */
  function cartItems() {
    var out = [];
    try {
      var c = window.tcart || (window.tcart__ && window.tcart__.get && window.tcart__.get());
      var products = (c && c.products) || [];
      products.forEach(function (p) {
        var id = p.externalid || p.external_id || p.sku;
        if (id) out.push({
          offer_id: String(p.sku || ''),
          sku: /^\d{8,}$/.test(String(id)) ? String(id) : '',
          quantity: Number(p.quantity) || 1,
          name: String(p.name || p.title || '')
        });
      });
    } catch (e) {}
    return out.filter(function (i) { return i.sku || i.offer_id; });
  }

  function setup(form) {
    if (form.getAttribute('data-ngpvz') === '1') return;
    var cityInput = form.querySelector('[name="' + CITY_FIELD + '"]');
    var addrInput = form.querySelector('[name="' + ADDR_FIELD + '"]');
    var typeSelect = form.querySelector('[name="' + TYPE_FIELD + '"]');
    if (!cityInput || !addrInput) return;
    form.setAttribute('data-ngpvz', '1');

    // Поле адреса заполняет виджет — вводить руками там нечего, иначе
    // получаются два поля ввода и путаница (жалоба покупателя).
    addrInput.readOnly = true;
    addrInput.placeholder = 'Выберите пункт выдачи ниже';
    addrInput.style.background = '#fafafa';

    var wrap = document.createElement('div');
    wrap.className = 'ngpvz';
    wrap.innerHTML =
      '<div class="ngpvz__actions">' +
        '<button type="button" class="ngpvz__geo">📍 Рядом со мной</button>' +
        '<button type="button" class="ngpvz__maptoggle">Показать карту</button>' +
        '<span class="ngpvz__count"></span>' +
      '</div>' +
      '<input type="text" class="ngpvz__search" placeholder="Поиск по улице или району" autocomplete="off">' +
      '<div class="ngpvz__map"></div>' +
      '<div class="ngpvz__list"></div>' +
      '<div class="ngpvz__chosen"></div>';
    addrInput.parentNode.insertBefore(wrap, addrInput.nextSibling);

    var box = wrap.querySelector('.ngpvz__list');
    var mapEl = wrap.querySelector('.ngpvz__map');
    var mapBtn = wrap.querySelector('.ngpvz__maptoggle');
    var geoBtn = wrap.querySelector('.ngpvz__geo');
    var countEl = wrap.querySelector('.ngpvz__count');
    var searchEl = wrap.querySelector('.ngpvz__search');
    var chosenEl = wrap.querySelector('.ngpvz__chosen');

    var st = { city: null, points: [], shown: [], userPos: null, map: null, layer: null, picked: null };
    var cityRequestSeq = 0;

    function setMapButton(text, expanded, busy) {
      mapBtn.textContent = text;
      mapBtn.disabled = !!busy;
      mapBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (busy) mapBtn.setAttribute('aria-busy', 'true');
      else mapBtn.removeAttribute('aria-busy');
    }

    function focusCityInput() {
      try { cityInput.focus({ preventScroll: true }); }
      catch (e) { cityInput.focus(); }
    }

    function clearMapCard() {
      var card = wrap.querySelector('.ngpvz__mapcard');
      if (card && card.parentNode) card.parentNode.removeChild(card);
    }

    function destroyMap() {
      clearMapCard();
      if (st.map && st.map.setTarget) {
        try { st.map.setTarget(null); } catch (e) {}
      }
      st.map = null;
      st.layer = null;
    }

    function showCityProblem(result, focus) {
      var reason = result && result.reason;
      if (reason === 'stale') return;
      wrap.classList.remove('ngpvz_map');
      if (reason === 'not_found') {
        setMapButton('Город не найден', false, false);
        countEl.textContent = 'Уточните название города.';
      } else if (reason === 'load_error') {
        setMapButton('Повторить загрузку карты', false, false);
        var value = norm(cityInput.value);
        var hasCurrentList = st.city && st.points.length && value &&
          (st.city._n === value || st.city._n.indexOf(value) === 0);
        countEl.textContent = hasCurrentList
          ? 'Карта не загрузилась — выберите пункт из списка или повторите попытку.'
          : 'Не удалось загрузить пункты. Повторите попытку.';
      } else if (reason === 'no_points') {
        setMapButton('Нет пунктов в городе', false, false);
        countEl.textContent = 'Для выбранного города пункты выдачи не найдены.';
      } else {
        setMapButton('Сначала выберите город', false, false);
        countEl.textContent = 'Введите город или используйте «Рядом со мной».';
      }
      if (focus) focusCityInput();
    }

    function pick(p) {
      st.picked = p;
      addrInput.value = kindText(p) + ', ' + st.city.city + ', ' + p.a + ' (пункт №' + p.i + ')';
      addrInput.dispatchEvent(new Event('input', { bubbles: true }));
      addrInput.dispatchEvent(new Event('change', { bubbles: true }));
      wrap.classList.remove('ngpvz_open', 'ngpvz_map');
      wrap.classList.add('ngpvz_chosen');
      clearMapCard();
      setMapButton('Показать карту', false, false);
      chosenEl.innerHTML =
        '<b>' + kindText(p) + '</b><br>' + p.a +
        (hoursText(p) ? '<br>Режим работы: ' + hoursText(p) : '') +
        '<br>Хранение заказа: ' + p.k + ' дн.' +
        '<div class="ngpvz__eta" style="margin-top:6px;color:#555">Уточняем срок доставки…</div>' +
        '<div style="margin-top:8px"><button type="button" class="ngpvz__change">Выбрать другой пункт</button></div>';
      chosenEl.querySelector('.ngpvz__change').addEventListener('click', function () {
        wrap.classList.remove('ngpvz_chosen');
        wrap.classList.add('ngpvz_open');
        render();
      });
      try { localStorage.setItem('ngpvz_city', st.city.city); } catch (e) {}
      askEta(p);
    }

    /**
     * Кнопка оплаты при недоставляемом товаре.
     *
     * Случай из жизни: товар был снят с продажи в кабинете Ozon, но остался
     * покупаемым на сайте. Покупатель заплатил, а Ozon отказался везти —
     * деньги списаны, отправления нет. Поэтому, если доставка невозможна,
     * до кассы не пускаем и прямо говорим, какой товар мешает.
     */
    function submitBtn() {
      return form.querySelector('.t-submit, .t-form__submit button, button[type="submit"], input[type="submit"]');
    }

    /**
     * Причин не пускать к кассе три: товар нельзя доставить, покупатель не
     * вошёл в кабинет и телефон заказа неизвестен Ozon. Держим их отдельно,
     * иначе снятие одной блокировки снимало бы и остальные.
     */
    var gate = { stock: null, auth: null, phone: null, mismatch: null };

    /**
     * Номер профиля — чтобы заметить чужой номер в заказе.
     *
     * Заказ у нас оформляют только после входа, а в профиле Tilda есть
     * телефон. Если в заказе номер другой — это либо опечатка, либо доставка
     * кому-то ещё. Различить может только сам покупатель, поэтому не
     * запрещаем, а спрашиваем один раз.
     */
    /**
     * Телефон профиля — читаем локально, из хранилища Tilda.
     *
     * Первая версия спрашивала его у воркера через /account/state, и это
     * не работало по построению: Tilda отказывается подтверждать токен
     * покупателя вне его браузера (горячий фикс 10.08 в ngr-stock.js,
     * журнал NG-2026-08-08-006). Воркер честно отвечал «нужен вход в
     * кабинет», телефон профиля оставался пустым, и сверка молчала.
     *
     * Тот же локальный слепок профиля читает ngr-stock.js, когда решает,
     * вошёл ли покупатель. Ключ проекта не зашиваем: перебираем все
     * ключи tilda_members_profile*, чтобы смена проекта ничего не сломала.
     */
    function профильныйТелефон() {
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (!k || k.indexOf('tilda_members_profile') !== 0) continue;
          if (/_timestamp$/.test(k)) continue;
          var p = JSON.parse(localStorage.getItem(k) || 'null');
          var t = p && p.phone ? String(p.phone).replace(/\D/g, '') : '';
          if (t.length === 10) t = '7' + t;
          if (t.length === 11 && t.charAt(0) === '8') t = '7' + t.slice(1);
          if (t.length === 11) return t;
        }
      } catch (e) {}
      return '';
    }

    /**
     * Телефон заказа. Ozon создаёт отправление в пункт выдачи только на номер,
     * у которого есть аккаунт Ozon.
     *
     * Случай из жизни, 13.08.2026, заказ 1868559242: покупатель оплатил
     * 1470 ₽, а отправление не создалось — «user with specified phone number
     * was not found». Проверено: тот же пункт и товар с номером, у которого
     * аккаунт есть, оформляются нормально, а формат номера ни при чём.
     * Значит спрашивать надо до кассы, а не после списания денег.
     */
    /**
     * Телефон у Tilda собран из трёх полей, и это ловушка:
     *   input[name="Phone"]                    скрытое, полный номер с кодом
     *   input[name="tildaspec-phone-part[]"]   видимая маска, БЕЗ кода страны
     *   input[name="tildaspec-phone-part[]-iso"] скрытое, страна
     *
     * Первая версия брала поле одним querySelector со списком селекторов через
     * запятую. Он возвращает первое совпадение по порядку в документе, а не по
     * порядку селекторов, и отдавал маску: десять цифр вместо одиннадцати.
     * Проверка отправляется только с одиннадцати — и не запускалась ни разу.
     * Нашёл Александр 13.08: подставил выдуманный номер, а корзина пропустила
     * к оплате, «как будто поля бутафория».
     *
     * Поэтому берём то поле, где цифр больше, и дописываем код страны сами,
     * когда пришла голая десятка.
     */
    function phoneDigits() {
      var полное = form.querySelector('input[name="Phone"]') ||
                   form.querySelector('input[name="phone"]');
      var маска = form.querySelector('input.t-input-phonemask') ||
                  form.querySelector('input[type="tel"]');
      var a = полное ? String(полное.value || '').replace(/\D/g, '') : '';
      var b = маска ? String(маска.value || '').replace(/\D/g, '') : '';
      var d = a.length >= b.length ? a : b;
      var iso = form.querySelector('input[name="tildaspec-phone-part[]-iso"]');
      var страна = iso ? String(iso.value || '').toUpperCase() : '';
      // Код страны дописываем только для России: доставка Ozon внутри РФ, а
      // для чужой страны угадывать код нельзя.
      if (d.length === 10 && (страна === 'RU' || страна === '')) d = '7' + d;
      if (d.length === 11 && d.charAt(0) === '8') d = '7' + d.slice(1);
      return d;
    }
    function красиво(digits) {
      return digits.length === 11
        ? ('+' + digits.charAt(0) + ' ' + digits.slice(1, 4) + ' ' + digits.slice(4, 7) +
           '-' + digits.slice(7, 9) + '-' + digits.slice(9))
        : digits;
    }

    /**
     * Напоминание, куда придёт код получения.
     *
     * Замечание Александра 13.08: заказ можно случайно оформить на чужой
     * номер. Проверка у Ozon этого не ловит — она отвечает «аккаунт на номере
     * существует», а не «он ваш», и почти любой действующий мобильный номер
     * такую проверку проходит. А отправление создаётся уже после оплаты, так
     * что владельцу чужого аккаунта придёт не просьба заплатить, а готовая
     * посылка с кодом получения: заплатил один, забрать может другой.
     *
     * Подтвердить владение номером может только код в SMS, которого у нас
     * нет. Пока — прямо говорим покупателю, что этот номер и есть ключ от
     * заказа: человек перечитывает номер, когда понимает, зачем он нужен.
     */
    function phoneNote() {
      var box = form.querySelector('.ngpvz__phone-note');
      if (!box) {
        box = document.createElement('div');
        box.className = 'ngpvz__phone-note';
        box.style.cssText = 'margin:10px 0 0;padding:10px 12px;border-radius:10px;' +
          'background:#f4f7fb;color:#42506a;font-size:13.5px;line-height:1.45';
        wrap.parentNode.insertBefore(box, wrap.nextSibling);
      }
      return box;
    }
    function showPhoneNote(digits) {
      var box = phoneNote();
      if (!digits || digits.length !== 11) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.style.display = '';
      box.innerHTML = 'Код получения придёт на <b>' + красиво(digits) + '</b>. ' +
        'По этому номеру в пункте выдадут заказ — проверьте, что он ваш и без опечаток.';
    }

    function blockPhone(digits) {
      var вид = красиво(digits);
      gate.phone = 'На номер <b>' + вид + '</b> доставку в пункт выдачи Ozon оформить нельзя: ' +
        'у этого номера нет аккаунта Ozon.' +
        '<br>Укажите номер, на который зарегистрирован ваш аккаунт Ozon, — или заведите его ' +
        'на <a href="https://www.ozon.ru" target="_blank" rel="noopener">ozon.ru</a>, это бесплатно ' +
        'и занимает минуту. Без аккаунта пункт выдачи не сможет отдать вам заказ.';
      applyGate();
    }
    function unblockPhone() {
      gate.phone = null;
      applyGate();
    }

    function askConfirmPhone(digits, профиль) {
      gate.mismatch = 'В вашем профиле другой номер: <b>' + красиво(профиль) + '</b>, ' +
        'а заказ уйдёт на <b>' + красиво(digits) + '</b> — код получения придёт туда, ' +
        'и по нему выдадут посылку.' +
        '<br><button type="button" class="ngpvz__okphone" style="margin-top:9px;border:0;' +
        'background:#f28c28;color:#fff;border-radius:10px;padding:9px 16px;font-size:14px;' +
        'font-family:inherit;cursor:pointer">Да, доставить на этот номер</button>';
      applyGate();
    }

    function stopperBox() {
      var box = form.querySelector('.ngpvz__stopper');
      if (!box) {
        box = document.createElement('div');
        box.className = 'ngpvz__stopper';
        box.style.cssText = 'margin:12px 0;padding:12px 14px;border:1px solid #f0b4b4;' +
          'background:#fff5f5;border-radius:10px;color:#a11;font-size:14px;line-height:1.45';
        wrap.parentNode.insertBefore(box, wrap.nextSibling);
      }
      return box;
    }

    function applyGate() {
      // Недоставляемый товар важнее: он мешает заказу целиком, а телефон
      // покупатель может просто поправить.
      var msg = gate.stock || gate.phone || gate.mismatch;
      var btn = submitBtn();
      // Вход проверяет ngr-stock — он работает на всём оформлении, а не только
      // на шаге с пунктом выдачи. Здесь только не снимаем его блокировку.
      if (!msg && btn && btn.getAttribute('data-ngr-auth-blocked') === '1') return;
      if (msg) {
        if (btn) {
          btn.setAttribute('data-ngpvz-blocked', '1');
          btn.disabled = true;
          btn.style.opacity = '0.45';
          btn.style.cursor = 'not-allowed';
        }
        var box = stopperBox();
        box.innerHTML = msg;
        var ok = box.querySelector('.ngpvz__okphone');
        if (ok) ok.onclick = function () {
          st.phoneConfirmed = phoneDigits();
          gate.mismatch = null;
          applyGate();
        };
        return;
      }
      if (btn && btn.getAttribute('data-ngpvz-blocked') === '1') {
        btn.removeAttribute('data-ngpvz-blocked');
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
      }
      var box = form.querySelector('.ngpvz__stopper');
      if (box) box.parentNode.removeChild(box);
    }

    function blockCheckout(names) {
      gate.stock = 'Этот товар сейчас нельзя доставить: <b>' + names.join('</b>, <b>') + '</b>.' +
        '<br>Удалите его из корзины — остальной заказ оформится как обычно.';
      applyGate();
    }

    function unblockCheckout() {
      gate.stock = null;
      applyGate();
    }

    /** Заказ только для зарегистрированных — проверку держит ngr-stock. */
    function loggedIn() {
      try { if (window.NGR_LOGGED_IN) return !!window.NGR_LOGGED_IN(); } catch (e) {}
      try { return !!(window.t_cart__getMembersToken && t_cart__getMembersToken()); } catch (e) {}
      return false;
    }

    /**
     * Пересчёт доступности при изменении корзины.
     *
     * Раньше проверка шла один раз — в момент выбора пункта выдачи. Покупатель
     * мог после этого докинуть товар или увеличить количество, и заказ уходил
     * в оплату без проверки: снова риск «деньги списаны, отправления нет».
     * Теперь состав корзины подписывается, и при любом расхождении проверка
     * повторяется, а перед самой отправкой формы — ещё раз.
     */
    function cartSig() {
      // Телефон входит в подпись: сменил номер — проверка пойдёт заново тем же
      // самым путём, что и при изменении состава корзины.
      return phoneDigits() + '#' + cartItems().map(function (i) {
        return i.offer_id + 'x' + i.quantity;
      }).sort().join('|');
    }

    st.checkedSig = null;

    setInterval(function () {
      if (!st.picked) return;
      var sig = cartSig();
      if (sig !== st.checkedSig) askEta(st.picked);
    }, 1500);

    // Последний рубеж: не пускаем к оплате, пока текущая корзина не проверена.
    // Если наш сервис не ответил — заказ пропускаем: своей ошибкой продажи
    // не блокируем, для этого есть проверка на стороне интегратора.
    form.addEventListener('submit', function (e) {
      if (!loggedIn()) return;   // остановит ngr-stock, он же покажет причину
      if (!st.picked) return;
      // Телефон без аккаунта Ozon — стоп независимо от подписи корзины:
      // кнопка уже отключена, но форму можно отправить и с клавиатуры.
      if (gate.phone || gate.mismatch) { e.preventDefault(); e.stopPropagation(); applyGate(); return; }
      // Повторная отправка после успешной проверки — пропускаем без вопросов,
      // иначе при сбое сети форма ушла бы в бесконечный круг.
      if (st.passOnce) { st.passOnce = false; return; }
      if (cartSig() === st.checkedSig) return;
      e.preventDefault();
      e.stopPropagation();
      var btn = submitBtn();
      if (btn) btn.disabled = true;
      askEta(st.picked, function (blocked) {
        if (btn) btn.disabled = false;
        if (blocked) return;
        st.passOnce = true;
        if (form.requestSubmit) form.requestSubmit(); else form.submit();
      });
    }, true);

    function askEta(p, done) {
      var eta = chosenEl.querySelector('.ngpvz__eta');
      var items = cartItems();
      var sig = cartSig();
      if (!items.length) { if (eta) eta.textContent = ''; st.checkedSig = sig; if (done) done(false); return; }
      // Телефон шлём только целиком: на полунабранном номере Ozon ответит
      // «не найден» у кого угодно, и корзина ругалась бы на каждой цифре.
      var тел = phoneDigits();
      var тело = { point_id: p.i, items: items };
      if (тел.length >= 11) тело.phone = тел;
      fetch(API + '/delivery/eta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(тело)
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.blocked && j.blocked.length) {
          var names = j.blocked.map(function (b) {
            var hit = items.filter(function (i) { return i.offer_id === b.offer_id; })[0];
            return (hit && hit.name) || ('артикул ' + b.offer_id);
          });
          if (eta) eta.textContent = '';
          st.checkedSig = sig;
          blockCheckout(names);
          if (done) done(true);
          return;
        }
        unblockCheckout();
        if (j && j.phone_known === false) {
          st.checkedSig = sig;
          if (eta) eta.textContent = '';
          showPhoneNote('');
          blockPhone(тел);
          if (done) done(true);
          return;
        }
        unblockPhone();
        showPhoneNote(тел);
        var профиль = профильныйТелефон();
        if (профиль && тел.length === 11 && тел !== профиль &&
            st.phoneConfirmed !== тел) {
          askConfirmPhone(тел, профиль);
          st.checkedSig = sig;
          if (done) done(true);
          return;
        }
        gate.mismatch = null;
        applyGate();
        st.checkedSig = sig;
        if (eta) {
          if (j && j.ok && j.from) {
            var a = fmtDate(j.from), b2 = fmtDate(j.to);
            eta.innerHTML = 'Доставим <b>' + (b2 && b2 !== a ? (a + ' — ' + b2) : a) + '</b>' +
              (j.splits > 1 ? '<br><span style="color:#8a8a8a;font-size:13px">Заказ приедет несколькими посылками</span>' : '');
          } else {
            eta.textContent = 'Срок доставки уточним при оформлении.';
          }
        }
        if (done) done(false);
      }).catch(function () {
        // Наш сервис не ответил — продажу не блокируем, подпись не отмечаем,
        // чтобы следующая попытка снова проверила состав корзины.
        if (eta) eta.textContent = '';
        if (done) done(false);
      });
    }

    /** Список показываем по тому же правилу, что и карту: ближе — выше. */
    function orderedPoints(query) {
      var pts = st.points;
      var q = norm(query);
      if (q) pts = pts.filter(function (p) { return norm(p.a).indexOf(q) > -1; });
      var center = st.userPos || (st.city ? { lat: st.city.y, lon: st.city.x } : null);
      if (center) {
        pts = pts.slice().sort(function (a, b) {
          return dist(center.lat, center.lon, a.y, a.x) - dist(center.lat, center.lon, b.y, b.x);
        });
      }
      return pts;
    }

    function render() {
      var pts = orderedPoints(searchEl.value);
      st.shown = pts.slice(0, MAX_IN_LIST);
      countEl.textContent = 'Пунктов: ' + pts.length + (st.points.length !== pts.length ? ' из ' + st.points.length : '');

      if (!st.shown.length) {
        box.innerHTML = '<div class="ngpvz__empty">Ничего не нашли. Уточните улицу или выберите другой город.</div>';
      } else {
        var center = st.userPos || (st.city ? { lat: st.city.y, lon: st.city.x } : null);
        box.innerHTML = st.shown.map(function (p, i) {
          var d = st.userPos ? dist(st.userPos.lat, st.userPos.lon, p.y, p.x) : null;
          return '<button type="button" class="ngpvz__item" data-i="' + i + '">' +
            '<span class="ngpvz__addr">' + (p.p ? 'Постамат · ' : '') + p.a + '</span>' +
            '<span class="ngpvz__meta">' +
              (d !== null ? (d < 1 ? Math.round(d * 1000) + ' м · ' : d.toFixed(1) + ' км · ') : '') +
              (hoursText(p) ? hoursText(p) + ' · ' : '') + 'хранение ' + p.k + ' дн.' +
              (p.r ? ' · ★ ' + p.r : '') +
            '</span></button>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('.ngpvz__item'), function (btn) {
          btn.addEventListener('click', function () { pick(st.shown[+btn.getAttribute('data-i')]); });
        });
      }
      if (wrap.classList.contains('ngpvz_map')) drawMap(cityRequestSeq);
    }

    /** На карте — точки видимой области, а не первые попавшиеся из списка. */
    function drawMap(requestSeq) {
      if (requestSeq && requestSeq !== cityRequestSeq) return Promise.resolve('stale');
      if (!st.city) {
        showCityProblem({ reason: 'empty' }, false);
        return Promise.resolve(false);
      }
      if (!st.points.length) {
        showCityProblem({ reason: 'no_points' }, false);
        return Promise.resolve(false);
      }
      setMapButton('Загружаем карту…', true, true);
      return loadMapLib().then(function () {
        if (requestSeq && requestSeq !== cityRequestSeq) return 'stale';
        if (!st.map) {
          var start = st.userPos ? [st.userPos.lon, st.userPos.lat] : [st.city.x, st.city.y];
          st.layer = new ol.source.Vector();
          st.map = new ol.Map({
            target: mapEl,
            controls: ol.control.defaults.defaults({ attribution: true, rotate: false }),
            layers: [
              new ol.layer.Tile({
                source: new ol.source.XYZ({ url: TILES, attributions: '© OpenStreetMap, © CARTO', maxZoom: 20 })
              }),
              new ol.layer.Vector({ source: st.layer })
            ],
            view: new ol.View({
              center: ol.proj.fromLonLat(start),
              zoom: st.userPos ? 14 : 11
            })
          });
          st.map.on('moveend', drawVisible);
          st.map.on('click', function (e) {
            var hit = st.map.forEachFeatureAtPixel(e.pixel, function (f) { return f; });
            if (hit && hit.get('point')) showPointCard(hit.get('point'));
          });
        }
        // Карта создаётся, пока её блок ещё сворачивается анимацией, и запоминает
        // неверную ширину — справа оставалась серая полоса. Пересчитываем размер
        // при каждом изменении блока, а не один раз по таймеру.
        if (!st.sizeWatch && window.ResizeObserver) {
          st.sizeWatch = new ResizeObserver(function () {
            if (st.map) { st.map.updateSize(); drawVisible(); }
          });
          st.sizeWatch.observe(mapEl);
        }
        [0, 120, 400, 900].forEach(function (ms) {
          setTimeout(function () { if (st.map) { st.map.updateSize(); drawVisible(); } }, ms);
        });
        setMapButton('Скрыть карту', true, false);
        return true;
      }).catch(function (error) {
        if (requestSeq && requestSeq !== cityRequestSeq) return 'stale';
        destroyMap();
        wrap.classList.remove('ngpvz_map');
        wrap.classList.add('ngpvz_open');
        setMapButton('Повторить загрузку карты', false, false);
        countEl.textContent = 'Карта не загрузилась — выберите пункт из списка или повторите попытку.';
        if (window.console && console.warn) console.warn('[NutryGo PVZ] map load failed', error);
        return false;
      });
    }

    /** Карточка пункта под картой: у OpenLayers нет всплывающих окон «из коробки». */
    function showPointCard(p) {
      var box = wrap.querySelector('.ngpvz__mapcard');
      if (!box) {
        box = document.createElement('div');
        box.className = 'ngpvz__mapcard';
        box.style.cssText = 'margin-top:8px;padding:12px 14px;border:1px solid #e6e6e6;' +
          'border-radius:12px;background:#fff;font-size:14px;line-height:1.45';
        mapEl.parentNode.insertBefore(box, mapEl.nextSibling);
      }
      box.innerHTML = '<b>' + kindText(p) + '</b><br>' + p.a +
        (hoursText(p) ? '<br>' + hoursText(p) : '') +
        '<br>Хранение: ' + p.k + ' дн.' + (p.r ? ' · ★ ' + p.r : '') +
        '<div style="margin-top:8px"><button type="button" class="ngpvz__pickmap" ' +
        'style="padding:9px 16px;border:0;border-radius:8px;background:#f28c28;color:#fff;' +
        'font-size:14px;cursor:pointer">Выбрать этот пункт</button></div>';
      box.querySelector('.ngpvz__pickmap').onclick = function () {
        pick(p);
        if (box.parentNode) box.parentNode.removeChild(box);
      };
    }

    function marker(lon, lat, fill, data) {
      var f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])) });
      f.setStyle(new ol.style.Style({
        image: new ol.style.Circle({
          radius: 8,
          fill: new ol.style.Fill({ color: fill }),
          stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
        })
      }));
      if (data) f.set('point', data);
      return f;
    }

    function drawVisible() {
      if (!st.map) return;
      var ext = ol.proj.transformExtent(
        st.map.getView().calculateExtent(st.map.getSize()), 'EPSG:3857', 'EPSG:4326');
      var inView = st.points.filter(function (p) {
        return p.x >= ext[0] && p.x <= ext[2] && p.y >= ext[1] && p.y <= ext[3];
      }).slice(0, MAX_ON_MAP);
      st.layer.clear();
      inView.forEach(function (p) {
        st.layer.addFeature(marker(p.x, p.y, p.p ? '#7c5cd6' : '#1f8a3b', p));
      });
      if (st.userPos) st.layer.addFeature(marker(st.userPos.lon, st.userPos.lat, '#1976d2'));
      countEl.textContent = 'Пунктов в городе: ' + st.points.length + ' · на карте: ' + inView.length;
    }

    function openCity(c, keepMap, requestSeq) {
      if (requestSeq && requestSeq !== cityRequestSeq) return Promise.resolve('stale');
      if (!c) return Promise.resolve(false);
      if (st.city && st.city.file === c.file && st.city.city === c.city && st.points.length) {
        var reopenMap = !!keepMap || wrap.classList.contains('ngpvz_map');
        wrap.classList.add('ngpvz_open');
        wrap.classList.remove('ngpvz_map');
        render();
        if (reopenMap) {
          wrap.classList.add('ngpvz_map');
          return drawMap(requestSeq);
        }
        setMapButton('Показать карту', false, false);
        return Promise.resolve(true);
      }
      return get(BASE + '/' + c.file).then(function (data) {
        if (requestSeq && requestSeq !== cityRequestSeq) return 'stale';
        var reopenMap = !!keepMap || wrap.classList.contains('ngpvz_map');
        st.city = c;
        st.points = Array.isArray(data) ? data : (data[c.city] || []);
        wrap.classList.add('ngpvz_open');
        wrap.classList.remove('ngpvz_chosen');
        wrap.classList.remove('ngpvz_map');
        destroyMap();
        render();
        if (reopenMap) {
          wrap.classList.add('ngpvz_map');
          return drawMap(requestSeq);
        }
        setMapButton('Показать карту', false, false);
        return true;
      });
    }

    function openByName(name, keepMap) {
      var requestSeq = ++cityRequestSeq;
      var value = String(name || '').trim();
      if (!norm(value)) return Promise.resolve({ ok: false, reason: 'empty' });
      return loadCities().then(function () {
        if (requestSeq !== cityRequestSeq) return { ok: false, reason: 'stale' };
        var city = findCity(value);
        if (!city) return { ok: false, reason: 'not_found' };
        return openCity(city, keepMap, requestSeq).then(function (mapReady) {
          if (requestSeq !== cityRequestSeq || mapReady === 'stale') return { ok: false, reason: 'stale' };
          return { ok: true, city: city, mapReady: mapReady !== false };
        });
      }).catch(function (error) {
        if (requestSeq !== cityRequestSeq) return { ok: false, reason: 'stale' };
        return { ok: false, reason: 'load_error', error: error };
      });
    }

    geoBtn.addEventListener('click', function () {
      if (!navigator.geolocation) { geoBtn.textContent = 'Геолокация недоступна'; return; }
      geoBtn.textContent = 'Определяем…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        st.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        geoBtn.textContent = '📍 Рядом со мной';
        loadCities().then(function () {
          var c = nearestCity(st.userPos.lat, st.userPos.lon);
          if (!c) return;
          cityInput.value = c.city;
          cityInput.dispatchEvent(new Event('input', { bubbles: true }));
          cityInput.dispatchEvent(new Event('change', { bubbles: true }));
          return openByName(c.city, true).then(function (result) {
            if (!result.ok && result.reason !== 'stale') {
              geoBtn.textContent = 'Не удалось загрузить пункты';
              showCityProblem(result, false);
              setTimeout(function () { geoBtn.textContent = '📍 Рядом со мной'; }, 3000);
            }
          });
        }).catch(function () {
          geoBtn.textContent = 'Не удалось загрузить пункты';
          showCityProblem({ reason: 'load_error' }, false);
          setTimeout(function () { geoBtn.textContent = '📍 Рядом со мной'; }, 3000);
        });
      }, function () {
        geoBtn.textContent = 'Не дали доступ к геопозиции';
        setTimeout(function () { geoBtn.textContent = '📍 Рядом со мной'; }, 3000);
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 });
    });

    mapBtn.addEventListener('click', function () {
      if (wrap.classList.contains('ngpvz_map')) {
        wrap.classList.remove('ngpvz_map');
        clearMapCard();
        setMapButton('Показать карту', false, false);
        return;
      }
      var value = String(cityInput.value || '').trim();
      var valueNorm = norm(value);
      var cityReady = st.city && st.points.length && valueNorm &&
        (st.city._n === valueNorm || st.city._n.indexOf(valueNorm) === 0);
      if (!value) {
        showCityProblem({ reason: 'empty' }, true);
        return;
      }
      if (!cityReady) {
        setMapButton('Ищем город…', false, true);
        openByName(value, true).then(function (result) {
          if (!result.ok) showCityProblem(result, true);
          else if (result.mapReady !== false) setMapButton('Скрыть карту', true, false);
        });
        return;
      }
      wrap.classList.add('ngpvz_map');
      drawMap(cityRequestSeq);
    });

    var t = null;
    cityInput.addEventListener('input', function () {
      clearTimeout(t);
      cityRequestSeq += 1;
      if (wrap.classList.contains('ngpvz_map') || mapBtn.disabled) {
        wrap.classList.remove('ngpvz_map');
        clearMapCard();
        setMapButton('Показать карту', false, false);
      }
      t = setTimeout(function () {
        openByName(cityInput.value).then(function (result) {
          if (result.ok && !wrap.classList.contains('ngpvz_map')) setMapButton('Показать карту', false, false);
          else if (result.reason === 'empty') showCityProblem(result, false);
        });
      }, 400);
    });
    cityInput.addEventListener('change', function () {
      openByName(cityInput.value).then(function (result) {
        if (result.ok && !wrap.classList.contains('ngpvz_map')) setMapButton('Показать карту', false, false);
        else if (!result.ok) showCityProblem(result, false);
      });
    });
    searchEl.addEventListener('input', function () { if (st.points.length) render(); });

    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        var courier = /курьер/i.test(typeSelect.value || '');
        wrap.style.display = courier ? 'none' : '';
        addrInput.readOnly = courier;
        addrInput.placeholder = courier ? 'Адрес доставки курьером' : 'Выберите пункт выдачи ниже';
        if (!courier && cityInput.value) openByName(cityInput.value).then(function (result) {
          if (!result.ok) showCityProblem(result, false);
        });
      });
    }

    try {
      var saved = localStorage.getItem('ngpvz_city');
      if (saved && !cityInput.value) {
        cityInput.value = saved;
        cityInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {}
    if (cityInput.value) openByName(cityInput.value).then(function (result) {
      if (!result.ok) showCityProblem(result, false);
    });
  }

  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll('form'), function (f) {
      if (f.querySelector('[name="' + CITY_FIELD + '"]')) setup(f);
    });
  }

  document.addEventListener('DOMContentLoaded', scan);
  new MutationObserver(function () { scan(); }).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
