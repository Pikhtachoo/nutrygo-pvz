/**
 * Выбор пункта выдачи Ozon в корзине nutry-go.ru. Версия 2: геолокация + карта.
 *
 * Покупатель вводит город (или нажимает «Рядом со мной» — тогда город
 * определяется по геопозиции) -> видит список действующих пунктов и постаматов,
 * отсортированный по близости -> может открыть карту -> выбирает точку.
 * Выбранный пункт подставляется в поле «Адрес пункта выдачи или доставки»
 * вместе с номером пункта — менеджер оформляет доставку без ручного поиска.
 *
 * Разрешение на геолокацию запрашивает браузер штатным диалогом и только
 * по нажатию кнопки. Отказ ничего не ломает: остаются ввод города и список.
 * Карта — Яндекс.Карты, подгружаются только при открытии карты.
 *
 * Данные — суточный справочник (см. build-pvz.ps1): в момент оформления заказа
 * запросов к Ozon нет, корзина не зависит от доступности API.
 */
(function () {
  'use strict';

  var BASE = window.NG_PVZ_BASE || 'https://pikhtachoo.github.io/nutrygo-pvz';
  // Яндекс.Карты — привычная покупателю схема города.
  var YMAPS_KEY = window.NG_YMAPS_KEY || '926196c7-a041-4032-be4f-503314e34a54';
  var YMAPS_JS = 'https://api-maps.yandex.ru/2.1/?apikey=' + YMAPS_KEY + '&lang=ru_RU';

  var CITY_FIELD = 'city';
  var ADDR_FIELD = 'address';
  var TYPE_FIELD = 'delivery_type';

  var cities = null;
  var ymapsLoading = null;

  // Стили новых элементов версии 2 — из скрипта, чтобы не править блок на сайте.
  (function () {
    var s = document.createElement('style');
    s.textContent =
      '.ngpvz__actions{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}' +
      '.ngpvz__geo,.ngpvz__maptoggle{border:1px solid #dcefc8;background:#fff;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;color:#222}' +
      '.ngpvz__geo:hover,.ngpvz__maptoggle:hover{background:#f4f9ee}' +
      '.ngpvz__map{height:320px;border:1px solid #dcefc8;border-radius:12px;margin-top:8px;overflow:hidden}' +
      '.ngpvz__map .ymaps-2-1-79-balloon__content{font-size:13px}';
    document.head.appendChild(s);
  })();

  function get(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function norm(s) {
    return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  }

  // Расстояние между координатами, км (приближённо — для сортировки хватает).
  function dist(lat1, lon1, lat2, lon2) {
    var kx = Math.cos(lat1 * Math.PI / 180) * 111.3;
    var dx = (lon1 - lon2) * kx;
    var dy = (lat1 - lat2) * 111.3;
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
    cities.forEach(function (c) {
      if (typeof c.y !== 'number') return;
      var d = dist(lat, lon, c.y, c.x);
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }

  function loadYmaps() {
    if (window.ymaps && window.ymaps.Map) return Promise.resolve();
    if (ymapsLoading) return ymapsLoading;
    ymapsLoading = new Promise(function (res, rej) {
      var js = document.createElement('script');
      js.src = YMAPS_JS;
      js.onload = function () { window.ymaps.ready(function () { res(); }); };
      js.onerror = function () { rej(new Error('ymaps load failed')); };
      document.head.appendChild(js);
    });
    return ymapsLoading;
  }

  function hoursText(p) { return p.h ? p.h.replace('-', '–') : ''; }

  function setup(form) {
    if (form.getAttribute('data-ngpvz') === '1') return;
    var cityInput = form.querySelector('[name="' + CITY_FIELD + '"]');
    var addrInput = form.querySelector('[name="' + ADDR_FIELD + '"]');
    var typeSelect = form.querySelector('[name="' + TYPE_FIELD + '"]');
    if (!cityInput || !addrInput) return;
    form.setAttribute('data-ngpvz', '1');

    var wrap = document.createElement('div');
    wrap.className = 'ngpvz';
    wrap.innerHTML =
      '<div class="ngpvz__actions">' +
        '<button type="button" class="ngpvz__geo">📍 Рядом со мной</button>' +
        '<button type="button" class="ngpvz__maptoggle" style="display:none">Карта</button>' +
        '<span class="ngpvz__count"></span>' +
      '</div>' +
      '<div class="ngpvz__head"><input type="text" class="ngpvz__search" placeholder="Поиск по улице" autocomplete="off"></div>' +
      '<div class="ngpvz__map" style="display:none"></div>' +
      '<div class="ngpvz__list"></div>';
    addrInput.parentNode.insertBefore(wrap, addrInput.nextSibling);

    var box = wrap.querySelector('.ngpvz__list');
    var mapEl = wrap.querySelector('.ngpvz__map');
    var mapBtn = wrap.querySelector('.ngpvz__maptoggle');
    var geoBtn = wrap.querySelector('.ngpvz__geo');
    var countEl = wrap.querySelector('.ngpvz__count');

    var current = { city: null, points: null, shown: [], userPos: null, map: null, markers: null };

    function pick(p) {
      // Номер пункта — прямо в строке адреса: скрытые поля Tilda в заказ не передаёт.
      addrInput.value = (p.p ? 'Постамат Ozon' : 'Пункт выдачи Ozon') + ', ' +
        current.city.city + ', ' + p.a + ' (пункт №' + p.i + ')';
      addrInput.dispatchEvent(new Event('input', { bubbles: true }));
      addrInput.dispatchEvent(new Event('change', { bubbles: true }));
      wrap.classList.remove('ngpvz_open');
      mapEl.style.display = 'none';
      countEl.textContent = 'Пункт выбран: №' + p.i + '. Изменить';
      try { localStorage.setItem('ngpvz_city', current.city.city); } catch (e) {}
    }

    function render(query) {
      var pts = current.points || [];
      var q = norm(query);
      if (q) pts = pts.filter(function (p) { return norm(p.a).indexOf(q) > -1; });
      if (current.userPos) {
        pts = pts.slice().sort(function (a, b) {
          return dist(current.userPos.lat, current.userPos.lon, a.y, a.x) -
                 dist(current.userPos.lat, current.userPos.lon, b.y, b.x);
        });
      }
      current.shown = pts = pts.slice(0, 60);

      if (!pts.length) {
        box.innerHTML = '<div class="ngpvz__empty">Ничего не нашли. Уточните улицу или другой город.</div>';
      } else {
        box.innerHTML = pts.map(function (p, i) {
          var d = current.userPos ? dist(current.userPos.lat, current.userPos.lon, p.y, p.x) : null;
          return '<button type="button" class="ngpvz__item" data-i="' + i + '">' +
            '<span class="ngpvz__addr">' + (p.p ? 'Постамат · ' : '') + p.a + '</span>' +
            '<span class="ngpvz__meta">' +
              (d !== null ? (d < 1 ? Math.round(d * 1000) + ' м · ' : d.toFixed(1) + ' км · ') : '') +
              (hoursText(p) ? hoursText(p) + ' · ' : '') +
              'хранение ' + p.k + ' дн.' + (p.r ? ' · ★ ' + p.r : '') +
            '</span></button>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('.ngpvz__item'), function (btn) {
          btn.addEventListener('click', function () { pick(current.shown[+btn.getAttribute('data-i')]); });
        });
      }
      if (mapEl.style.display !== 'none') drawMap();
    }

    function drawMap() {
      loadYmaps().then(function () {
        if (!current.map) {
          current.map = new ymaps.Map(mapEl, {
            center: [55.751574, 37.573856], zoom: 11,
            controls: ['zoomControl', 'geolocationControl']
          }, { suppressMapOpenBlock: true });
        }
        current.map.geoObjects.removeAll();

        // Пункты складываются в кластеры — на карте города иначе каша из меток.
        var clusterer = new ymaps.Clusterer({
          preset: 'islands#greenClusterIcons',
          groupByCoordinates: false,
          clusterDisableClickZoom: false,
          gridSize: 64
        });

        var placemarks = current.shown.map(function (p) {
          var title = p.p ? 'Постамат Ozon' : 'Пункт выдачи Ozon';
          var pm = new ymaps.Placemark([p.y, p.x], {
            balloonContentHeader: title,
            balloonContentBody:
              '<div style="font-size:13px;line-height:1.5">' + p.a +
              (p.h ? '<br>Режим работы: ' + hoursText(p) : '') +
              '<br>Хранение: ' + p.k + ' дн.' + (p.r ? ' · Рейтинг: ' + p.r : '') + '</div>',
            balloonContentFooter:
              '<button type="button" class="ngpvz__pickmap" style="margin-top:6px;padding:7px 14px;border:0;border-radius:8px;background:#f28c28;color:#fff;font-size:13px;cursor:pointer">Выбрать этот пункт</button>',
            hintContent: p.a
          }, {
            preset: p.p ? 'islands#violetDeliveryIcon' : 'islands#greenDeliveryCircleIcon'
          });
          pm.events.add('balloonopen', function () {
            setTimeout(function () {
              var btn = document.querySelector('.ngpvz__pickmap');
              if (btn) btn.onclick = function () { pick(p); current.map.balloon.close(); };
            }, 60);
          });
          return pm;
        });

        clusterer.add(placemarks);
        current.map.geoObjects.add(clusterer);

        if (current.userPos) {
          current.map.geoObjects.add(new ymaps.Placemark(
            [current.userPos.lat, current.userPos.lon],
            { hintContent: 'Вы здесь' },
            { preset: 'islands#blueCircleDotIcon' }
          ));
        }

        if (placemarks.length) {
          current.map.setBounds(clusterer.getBounds(), { checkZoomRange: true, zoomMargin: 30 });
        }
        current.map.container.fitToViewport();
      }).catch(function () {
        mapEl.style.display = 'none';
        mapBtn.textContent = 'Карта недоступна';
      });
    }

    function openCity(c) {
      if (!c) return;
      return get(BASE + '/' + c.file).then(function (points) {
        current.city = c;
        current.points = points;
        wrap.classList.add('ngpvz_open');
        mapBtn.style.display = '';
        countEl.textContent = 'Пунктов в городе: ' + points.length;
        render(wrap.querySelector('.ngpvz__search').value);
      });
    }

    function openByName(name) {
      loadCities().then(function () { return openCity(findCity(name)); })
        .catch(function () { /* справочник недоступен — остаётся ручной ввод */ });
    }

    geoBtn.addEventListener('click', function () {
      if (!navigator.geolocation) { geoBtn.textContent = 'Геолокация недоступна'; return; }
      geoBtn.textContent = 'Определяем…';
      navigator.geolocation.getCurrentPosition(function (pos) {
        current.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        geoBtn.textContent = '📍 Рядом со мной';
        loadCities().then(function () {
          var c = nearestCity(current.userPos.lat, current.userPos.lon);
          if (!c) return;
          cityInput.value = c.city;
          cityInput.dispatchEvent(new Event('input', { bubbles: true }));
          cityInput.dispatchEvent(new Event('change', { bubbles: true }));
          openCity(c).then(function () {
            mapEl.style.display = '';
            drawMap();
          });
        });
      }, function () {
        geoBtn.textContent = 'Доступ к геопозиции не дан';
        setTimeout(function () { geoBtn.textContent = '📍 Рядом со мной'; }, 3000);
      }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
    });

    mapBtn.addEventListener('click', function () {
      var show = mapEl.style.display === 'none';
      mapEl.style.display = show ? '' : 'none';
      mapBtn.textContent = show ? 'Скрыть карту' : 'Карта';
      if (show) drawMap();
    });

    var t = null;
    cityInput.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { openByName(cityInput.value); }, 400);
    });
    cityInput.addEventListener('change', function () { openByName(cityInput.value); });

    wrap.querySelector('.ngpvz__search').addEventListener('input', function (e) {
      if (current.points) render(e.target.value);
    });

    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        var courier = /курьер/i.test(typeSelect.value || '');
        wrap.style.display = courier ? 'none' : '';
        if (!courier && cityInput.value) openByName(cityInput.value);
      });
    }

    // Вспоминаем прошлый город (без запроса — просто удобство).
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
