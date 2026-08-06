/**
 * Выбор пункта выдачи Ozon в корзине nutry-go.ru.
 *
 * Покупатель вводит город -> получает список действующих пунктов и постаматов
 * с адресом, часами работы и сроком хранения -> выбирает один. Выбранный пункт
 * подставляется в поле «Адрес пункта выдачи или доставки», а его номер уходит
 * в скрытом поле, чтобы менеджер оформил доставку без ручного поиска.
 *
 * Данные — суточный справочник (см. build-pvz.ps1), поэтому в момент оформления
 * заказа никаких обращений к Ozon не происходит: корзина открывается мгновенно
 * и не зависит от доступности API.
 *
 * Вставляется блоком T123 на страницу с корзиной.
 */
(function () {
  'use strict';

  var BASE = window.NG_PVZ_BASE || 'https://pikhtachoo.github.io/nutrygo-pvz';
  if (!BASE) return;

  var CITY_FIELD = 'city';
  var ADDR_FIELD = 'address';
  var TYPE_FIELD = 'delivery_type';
  var POINT_FIELD = 'ozon_point_id';             // скрытое поле с номером пункта

  var cities = null;      // индекс городов
  var loading = {};       // защита от повторных загрузок
  var box = null;         // выпадающий список пунктов

  function get(url) {
    return fetch(url, { credentials: 'omit' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function norm(s) {
    return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
  }

  function loadCities() {
    if (cities || loading.cities) return Promise.resolve(cities);
    loading.cities = true;
    return get(BASE + '/cities.json').then(function (m) {
      cities = m.list || [];
      cities.forEach(function (c) { c._n = norm(c.city); });
      return cities;
    }).catch(function () { loading.cities = false; return null; });
  }

  function findCity(name) {
    if (!cities) return null;
    var n = norm(name);
    if (!n) return null;
    var exact = cities.filter(function (c) { return c._n === n; });
    if (exact.length) return exact.sort(function (a, b) { return b.count - a.count; })[0];
    var starts = cities.filter(function (c) { return c._n.indexOf(n) === 0; });
    if (starts.length) return starts.sort(function (a, b) { return b.count - a.count; })[0];
    return null;
  }

  function hoursText(p) {
    return p.h ? p.h.replace('-', '–') : '';
  }

  function render(points, query, onPick) {
    var q = norm(query);
    var list = points;
    if (q) {
      list = points.filter(function (p) { return norm(p.a).indexOf(q) > -1; });
    }
    list = list.slice(0, 60);

    if (!list.length) {
      box.innerHTML = '<div class="ngpvz__empty">Ничего не нашли. Уточните улицу или выберите другой город.</div>';
      return;
    }

    box.innerHTML = list.map(function (p, idx) {
      return '<button type="button" class="ngpvz__item" data-idx="' + idx + '">' +
        '<span class="ngpvz__addr">' + (p.p ? 'Постамат · ' : '') + p.a + '</span>' +
        '<span class="ngpvz__meta">' +
          (hoursText(p) ? hoursText(p) + ' · ' : '') +
          'хранение ' + p.k + ' дн.' +
          (p.r ? ' · рейтинг ' + p.r : '') +
        '</span></button>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('.ngpvz__item'), function (btn) {
      btn.addEventListener('click', function () {
        onPick(list[parseInt(btn.getAttribute('data-idx'), 10)]);
      });
    });
  }

  function fieldByName(form, name) {
    return form.querySelector('[name="' + name + '"]');
  }

  function ensureHidden(form) {
    var h = fieldByName(form, POINT_FIELD);
    if (!h) {
      h = document.createElement('input');
      h.type = 'hidden';
      h.name = POINT_FIELD;
      form.appendChild(h);
    }
    return h;
  }

  function setup(form) {
    if (form.getAttribute('data-ngpvz') === '1') return;
    var cityInput = fieldByName(form, CITY_FIELD);
    var addrInput = fieldByName(form, ADDR_FIELD);
    var typeSelect = fieldByName(form, TYPE_FIELD);
    if (!cityInput || !addrInput) return;
    form.setAttribute('data-ngpvz', '1');

    var hidden = ensureHidden(form);
    var wrap = document.createElement('div');
    wrap.className = 'ngpvz';
    wrap.innerHTML =
      '<div class="ngpvz__head">' +
        '<input type="text" class="ngpvz__search" placeholder="Поиск по улице" autocomplete="off">' +
        '<span class="ngpvz__count"></span>' +
      '</div><div class="ngpvz__list"></div>';
    addrInput.parentNode.insertBefore(wrap, addrInput.nextSibling);
    box = wrap.querySelector('.ngpvz__list');

    var current = { city: null, points: null };

    function pick(p) {
      addrInput.value = (p.p ? 'Постамат Ozon' : 'Пункт выдачи Ozon') + ', ' +
        current.city.city + ', ' + p.a;
      addrInput.dispatchEvent(new Event('input', { bubbles: true }));
      addrInput.dispatchEvent(new Event('change', { bubbles: true }));
      hidden.value = p.i;
      wrap.classList.remove('ngpvz_open');
      wrap.querySelector('.ngpvz__count').textContent = 'Пункт выбран. Изменить';
    }

    function openFor(cityName) {
      loadCities().then(function () {
        var c = findCity(cityName);
        if (!c) {
          wrap.classList.remove('ngpvz_open');
          return;
        }
        if (current.city && current.city.file === c.file && current.points) {
          wrap.classList.add('ngpvz_open');
          render(current.points, '', pick);
          return;
        }
        return get(BASE + '/' + c.file).then(function (points) {
          current.city = c;
          current.points = points;
          wrap.classList.add('ngpvz_open');
          wrap.querySelector('.ngpvz__count').textContent =
            'Пунктов в городе: ' + points.length;
          render(points, '', pick);
        });
      }).catch(function () { /* справочник недоступен — остаётся ручной ввод */ });
    }

    var t = null;
    cityInput.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { openFor(cityInput.value); }, 400);
    });
    cityInput.addEventListener('change', function () { openFor(cityInput.value); });

    wrap.querySelector('.ngpvz__search').addEventListener('input', function (e) {
      if (current.points) render(current.points, e.target.value, pick);
    });

    // Курьерская доставка: пункты не нужны, прячем список.
    if (typeSelect) {
      typeSelect.addEventListener('change', function () {
        var courier = /курьер/i.test(typeSelect.value || '');
        wrap.style.display = courier ? 'none' : '';
        if (courier) { hidden.value = ''; }
        else if (cityInput.value) { openFor(cityInput.value); }
      });
    }

    if (cityInput.value) openFor(cityInput.value);
  }

  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll('form'), function (f) {
      if (f.querySelector('[name="' + CITY_FIELD + '"]')) setup(f);
    });
  }

  // Корзина Tilda появляется в момент открытия — следим за изменениями страницы.
  document.addEventListener('DOMContentLoaded', scan);
  var mo = new MutationObserver(function () { scan(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
