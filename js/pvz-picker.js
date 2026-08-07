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
    '@media (max-width:600px){.ngpvz__map{height:240px}.ngpvz__list{max-height:220px}}';
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
  function loadMapLib() {
    if (window.ol) return Promise.resolve();
    if (mapLibLoading) return mapLibLoading;
    mapLibLoading = new Promise(function (res, rej) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = MAPLIB_CSS;
      document.head.appendChild(link);
      var js = document.createElement('script');
      js.src = MAPLIB_JS;
      js.onload = function () { res(); };
      js.onerror = function () { rej(new Error('map lib failed')); };
      document.head.appendChild(js);
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

    function pick(p) {
      st.picked = p;
      addrInput.value = kindText(p) + ', ' + st.city.city + ', ' + p.a + ' (пункт №' + p.i + ')';
      addrInput.dispatchEvent(new Event('input', { bubbles: true }));
      addrInput.dispatchEvent(new Event('change', { bubbles: true }));
      wrap.classList.remove('ngpvz_open', 'ngpvz_map');
      wrap.classList.add('ngpvz_chosen');
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

    function blockCheckout(names) {
      var btn = submitBtn();
      if (btn) {
        btn.setAttribute('data-ngpvz-blocked', '1');
        btn.disabled = true;
        btn.style.opacity = '0.45';
        btn.style.cursor = 'not-allowed';
      }
      var box = form.querySelector('.ngpvz__stopper');
      if (!box) {
        box = document.createElement('div');
        box.className = 'ngpvz__stopper';
        box.style.cssText = 'margin:12px 0;padding:12px 14px;border:1px solid #f0b4b4;' +
          'background:#fff5f5;border-radius:10px;color:#a11;font-size:14px;line-height:1.45';
        wrap.parentNode.insertBefore(box, wrap.nextSibling);
      }
      box.innerHTML = 'Этот товар сейчас нельзя доставить: <b>' + names.join('</b>, <b>') + '</b>.' +
        '<br>Удалите его из корзины — остальной заказ оформится как обычно.';
    }

    function unblockCheckout() {
      var btn = submitBtn();
      if (btn && btn.getAttribute('data-ngpvz-blocked') === '1') {
        btn.removeAttribute('data-ngpvz-blocked');
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.cursor = '';
      }
      var box = form.querySelector('.ngpvz__stopper');
      if (box) box.parentNode.removeChild(box);
    }

    function askEta(p) {
      var eta = chosenEl.querySelector('.ngpvz__eta');
      var items = cartItems();
      if (!eta) return;
      if (!items.length) { eta.textContent = ''; return; }
      fetch(API + '/delivery/eta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ point_id: p.i, items: items })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.blocked && j.blocked.length) {
          var names = j.blocked.map(function (b) {
            var hit = items.filter(function (i) { return i.offer_id === b.offer_id; })[0];
            return (hit && hit.name) || ('артикул ' + b.offer_id);
          });
          eta.textContent = '';
          blockCheckout(names);
          return;
        }
        unblockCheckout();
        if (j && j.ok && j.from) {
          var a = fmtDate(j.from), b2 = fmtDate(j.to);
          eta.innerHTML = 'Доставим <b>' + (b2 && b2 !== a ? (a + ' — ' + b2) : a) + '</b>' +
            (j.splits > 1 ? '<br><span style="color:#8a8a8a;font-size:13px">Заказ приедет несколькими посылками</span>' : '');
        } else {
          eta.textContent = 'Срок доставки уточним при оформлении.';
        }
      }).catch(function () { eta.textContent = ''; });
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
      if (wrap.classList.contains('ngpvz_map')) drawMap();
    }

    /** На карте — точки видимой области, а не первые попавшиеся из списка. */
    function drawMap() {
      loadMapLib().then(function () {
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
      }).catch(function () {
        wrap.classList.remove('ngpvz_map');
        mapBtn.textContent = 'Карта недоступна';
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

    function openCity(c, keepMap) {
      if (!c) return Promise.resolve();
      if (st.city && st.city.file === c.file && st.city.city === c.city && st.points.length) {
        wrap.classList.add('ngpvz_open');
        render();
        return Promise.resolve();
      }
      return get(BASE + '/' + c.file).then(function (data) {
        st.city = c;
        st.points = Array.isArray(data) ? data : (data[c.city] || []);
        wrap.classList.add('ngpvz_open');
        wrap.classList.remove('ngpvz_chosen');
        if (st.map) { st.map.remove(); st.map = null; }
        render();
        if (keepMap) { wrap.classList.add('ngpvz_map'); mapBtn.textContent = 'Скрыть карту'; drawMap(); }
      });
    }

    function openByName(name, keepMap) {
      loadCities().then(function () { return openCity(findCity(name), keepMap); }).catch(function () {});
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
          openCity(c, true);
        });
      }, function () {
        geoBtn.textContent = 'Не дали доступ к геопозиции';
        setTimeout(function () { geoBtn.textContent = '📍 Рядом со мной'; }, 3000);
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 });
    });

    mapBtn.addEventListener('click', function () {
      var show = !wrap.classList.contains('ngpvz_map');
      wrap.classList.toggle('ngpvz_map', show);
      mapBtn.textContent = show ? 'Скрыть карту' : 'Показать карту';
      if (show) {
        if (!st.points.length && cityInput.value) openByName(cityInput.value, true);
        else drawMap();
      }
    });

    var t = null;
    cityInput.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { openByName(cityInput.value); }, 400);
    });
    cityInput.addEventListener('change', function () { openByName(cityInput.value); });
    searchEl.addEventListener('input', function () { if (st.points.length) render(); });

    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        var courier = /курьер/i.test(typeSelect.value || '');
        wrap.style.display = courier ? 'none' : '';
        addrInput.readOnly = courier;
        addrInput.placeholder = courier ? 'Адрес доставки курьером' : 'Выберите пункт выдачи ниже';
        if (!courier && cityInput.value) openByName(cityInput.value);
      });
    }

    try {
      var saved = localStorage.getItem('ngpvz_city');
      if (saved && !cityInput.value) {
        cityInput.value = saved;
        cityInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (e) {}
    if (cityInput.value) openByName(cityInput.value);
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
