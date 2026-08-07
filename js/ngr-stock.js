/**
 * Защита от покупки того, что нельзя отправить (nutry-go.ru).
 *
 * Случай из жизни, 06.08.2026: товар был снят с продажи в кабинете Ozon, но
 * на сайте остался покупаемым — всплывающая карточка Tilda показывает кнопку
 * «В корзину» независимо от остатка. Покупатель оплатил 886 ₽, а Ozon отказался
 * везти (BANNED), и отправление не создалось.
 *
 * Здесь две страховки:
 *   1. Всплывающая карточка уважает остаток самой Tilda (data-product-inv).
 *   2. Список «нельзя продать» берётся у Ozon через интегратор — витрина Tilda
 *      это лишь копия остатков, а решает всегда Ozon.
 */
(function () {
  'use strict';
  if (window.NGR_STOCK_GUARD) return;
  window.NGR_STOCK_GUARD = 1;

  var API = 'https://nutrygo-integrator.pikhtovnikov-alieksandr.workers.dev';
  var blocked = null;          // Set артикулов, пока не загружен — null
  var LABEL = 'Нет в наличии';

  /**
   * Живые остатки.
   *
   * Синхронизацию каталога Tilda пришлось выключить — внешний сборщик ломал
   * карточки. Остатки в Tilda теперь заливаются файлом раз в неделю и к концу
   * недели врут: покупатель кладёт в корзину то, чего уже нет, и упирается
   * в отказ на последнем шаге. Поэтому наличие берём прямо у Ozon, а числа
   * из вёрстки Tilda используем только пока снимок не пришёл.
   *
   * Артикула нет в снимке — значит остаток нулевой.
   */
  var liveStock = null;

  fetch(API + '/catalog/unavailable')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      blocked = {};
      (j.offers || []).forEach(function (o) { blocked[String(o)] = 1; });
      apply();
    })
    .catch(function () { blocked = {}; });

  fetch(API + '/catalog/stock')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.stock || !j.updated) return;   // снимок ещё строится
      liveStock = j.stock;
      skuOf = j.sku || null;      // связка «артикул → SKU» для отзывов
      // Числа изменились — пересматриваем и уже показанные карточки.
      document.querySelectorAll('[data-ngr-hidden]').forEach(function (c) {
        c.removeAttribute('data-ngr-hidden');
        c.style.removeProperty('display');
      });
      apply();
    })
    .catch(function () {});

  /** Остаток товара: живой, если снимок пришёл, иначе число из вёрстки Tilda. */
  function stockOf(article, invAttr) {
    if (liveStock && article) return Number(liveStock[article] || 0);
    return invAttr === null || invAttr === undefined ? null : Number(invAttr);
  }

  /** Артикул товара из вёрстки Tilda: «Артикул: 32550». */
  function article(root) {
    var el = root.querySelector('.t-catalog__card__sku, .t-store__prod-popup__sku, [class*="__sku"]');
    if (!el) return '';
    var m = (el.textContent || '').match(/(\d{3,})/);
    return m ? m[1] : '';
  }

  function unavailable(root, invAttr) {
    var a = article(root);
    // Живой остаток важнее числа из вёрстки: карточка могла быть отрисована
    // с прошлой недельной заливки.
    var inv = stockOf(a, invAttr);
    if (inv !== null && inv <= 0) return true;
    return !!(a && blocked && blocked[a]);
  }

  function stopClick(e) { e.preventDefault(); e.stopPropagation(); }

  function disableButton(btn) {
    if (!btn || btn.getAttribute('data-ngr-stock') === '1') return;
    btn.setAttribute('data-ngr-stock', '1');
    btn.setAttribute('data-ngr-label', btn.textContent);
    btn.textContent = LABEL;
    btn.style.setProperty('pointer-events', 'none', 'important');
    btn.style.setProperty('opacity', '0.45', 'important');
    btn.style.setProperty('cursor', 'not-allowed', 'important');
    btn.setAttribute('aria-disabled', 'true');
    // Клик по кнопке Tilda вешается на всплытии — глушим на перехвате.
    btn.addEventListener('click', stopClick, true);
  }

  /**
   * Всплывающая карточка переиспользуется для всех товаров, поэтому запрет
   * обязан сниматься: иначе первый недоступный товар «заразит» все следующие.
   */
  function enableButton(btn) {
    if (!btn || btn.getAttribute('data-ngr-stock') !== '1') return;
    btn.removeAttribute('data-ngr-stock');
    var label = btn.getAttribute('data-ngr-label');
    if (label) { btn.textContent = label; btn.removeAttribute('data-ngr-label'); }
    btn.style.removeProperty('pointer-events');
    btn.style.removeProperty('opacity');
    btn.style.removeProperty('cursor');
    btn.removeAttribute('aria-disabled');
    btn.removeEventListener('click', stopClick, true);
  }

  /**
   * Всплывающая карточка товара: главная дыра — здесь. Своего артикула у неё
   * может ещё не быть (заполняется позже), поэтому товар опознаём по адресу
   * страницы (?ngprod=UID) и берём остаток с карточки каталога.
   */
  function fixPopup() {
    var pop = document.querySelector('.t-catalog__product-popup, .t-store__prod-popup');
    if (!pop) return;
    var uid = pop.getAttribute('data-product-uid') ||
      (location.search.match(/ngprod=(\d+)/) || [])[1] || '';
    var card = uid ? document.querySelector('.js-product[data-product-uid="' + uid + '"]') : null;
    var inv = card ? card.getAttribute('data-product-inv') : null;
    var art = article(pop) || (card ? article(card) : '');
    var bad = String(inv) === '0' || !!(art && blocked && blocked[art]);
    var btns = pop.querySelectorAll('a.t-btn, button.t-btn, [class*="prod-popup__btn"]');
    // Пока список не загружен и остаток неизвестен — ничего не трогаем.
    if (!bad && (blocked === null && inv === null)) return;
    btns.forEach(bad ? disableButton : enableButton);
  }

  /**
   * Карточки в каталоге: товара, который нельзя купить, на витрине быть не
   * должно — «Нет в наличии» на полке только раздражает покупателя. Прячем
   * то, что снято с продажи в Ozon, и малые остатки: решение Александра
   * 07.08.2026 — до 3 штук включительно не показывать (склад может разойтись
   * на маркетплейсе раньше, чем соберём заказ с сайта).
   *
   * Пока список не загружен — не трогаем ничего: пустая витрина из-за сбоя
   * сети хуже, чем лишняя карточка.
   */
  var MIN_STOCK = 4; // показываем от 4 штук

  function fixCards() {
    if (!blocked) return;
    document.querySelectorAll('.js-product').forEach(function (c) {
      if (c.getAttribute('data-ngr-hidden') === '1') return;
      var a = article(c);
      var inv = stockOf(a, c.getAttribute('data-product-inv'));
      var bad = (inv !== null && inv < MIN_STOCK) || !!(a && blocked[a]);
      if (!bad) return;
      c.setAttribute('data-ngr-hidden', '1');
      c.style.setProperty('display', 'none', 'important');
    });
  }

  /**
   * Последний рубеж: если недоступный товар всё же попал в корзину (лежал там
   * со вчера), покупатель должен увидеть это до оплаты, а не после списания.
   */
  function fixCart() {
    if (!blocked) return;
    var cart = window.tcart;
    if (!cart || !cart.products || !cart.products.length) return;
    var bad = cart.products.filter(function (p) { return blocked[String(p.sku || '')]; });
    var host = document.querySelector('.t-store__cart-form, .t706__cartwin-content');
    if (!host) return;
    var box = host.querySelector('.ngr-stock-warn');
    if (!bad.length) { if (box) box.parentNode.removeChild(box); return; }
    if (!box) {
      box = document.createElement('div');
      box.className = 'ngr-stock-warn';
      box.style.cssText = 'margin:12px 0;padding:12px 14px;border:1px solid #f0b4b4;' +
        'background:#fff5f5;border-radius:10px;color:#a11;font-size:14px;line-height:1.45';
      host.insertBefore(box, host.firstChild);
    }
    box.innerHTML = 'Сейчас нельзя доставить: <b>' +
      bad.map(function (p) { return p.name || ('артикул ' + p.sku); }).join('</b>, <b>') +
      '</b>.<br>Удалите товар из корзины, чтобы оформить остальное.';
  }

  /**
   * Дубль виджета доставки. Новый виджет («⌖ Ozon Доставка…») рисует основной
   * скрипт сайта; старый («📍 Доставка в…») остался старой копией в блоке
   * шаблона товара и показывал выдуманный срок рядом с настоящим. Убираем
   * старый на лету — править шаблон Tilda не нужно.
   */
  function fixDupDelivery() {
    document.querySelectorAll('.nutrygo-delivery').forEach(function (w) {
      var t = (w.textContent || '').trim();
      if (/Ozon Доставка/.test(t)) return;         // новый — оставляем
      if (/^📍|Доставка в/.test(t)) w.parentNode && w.parentNode.removeChild(w);
    });
  }

  /**
   * Приписка «/1 шт» у цены — единицы измерения Tilda голым текстовым узлом
   * (элемента нет, стилями не спрятать). Все товары штучные, приписка шумит.
   */
  function fixUnits() {
    document.querySelectorAll('[class*="price"]').forEach(function (el) {
      for (var i = el.childNodes.length - 1; i >= 0; i--) {
        var n = el.childNodes[i];
        if (n.nodeType !== 3) continue;
        var v = n.nodeValue || '';
        // «/», «/1», «/1 шт», «1 шт», «шт.» — но не голые числа (это сама цена)
        if (/^\s*\/\s*\d*\s*(шт\.?)?\s*$/.test(v) || /^\s*\d*\s*шт\.?\s*$/.test(v) && /шт/.test(v)) el.removeChild(n);
      }
    });
    // В личном кабинете шаблон единиц не подставляется и торчит буквально:
    // «1 {{units_шт.}}», «2 051 р./{{units_шт.}}» — вычищаем.
    if (document.body && document.body.textContent.indexOf('{{units') >= 0) {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = w.nextNode())) {
        if (node.nodeValue && node.nodeValue.indexOf('{{units') >= 0) {
          node.nodeValue = node.nodeValue.replace(/\s*\/?\s*\{\{units[^}]*\}\}/g, '');
        }
      }
    }
  }

  /**
   * Плитки брендов на главной: вместо голого названия — товар этого бренда
   * с максимальным остатком (решение Александра 07.08). Список пересчитывается
   * при синхронизации каталога; клик по плитке по-прежнему ведёт в фильтр бренда.
   */
  // Фирменные карточки брендов (дизайнерские PNG из D:\Работа\NUTRY\ФОТО,
  // раздаются воркером из KV). Строка «от N ₽ · в наличии» — по товару бренда
  // с максимальным остатком, пересчитывается при синхронизации каталога.
  var FILES = 'https://nutrygo-integrator.pikhtovnikov-alieksandr.workers.dev/file/';
  var BRAND_TOP = {
    'NOW':                       'brand-now.jpg',
    'Life Extension':            'brand-life-extension.jpg',
    // У CGN нет товаров в наличии — на её месте Olimp (56 позиций на складе),
    // решение Александра 07.08. Ссылка плитки тоже переводится на Olimp.
    'California Gold Nutrition': { img: 'brand-olimp.jpg', brand: 'Olimp' },
    'Swanson':                   'brand-swanson.jpg',
    'Solaray':                   'brand-solaray.jpg',
    'Ultimate Nutrition':        'brand-ultimate.jpg',
    'OstroVit':                  'brand-ostrovit.jpg',
    'VPLAB':                     'brand-vplab.jpg'
  };

  function fixBrands() {
    var grid = document.querySelector('.ngr-brand-grid');
    if (!grid || grid.getAttribute('data-ngr-top') === '1') return;
    grid.setAttribute('data-ngr-top', '1');
    if (!document.getElementById('ngr-brand-top-css')) {
      var st = document.createElement('style');
      st.id = 'ngr-brand-top-css';
      // !important: базовые стили плиток зажимали картинку до «логотипа»
      // (max-height 50px) и высоту плитки до 110px.
      st.textContent =
        '.ngr-brand.ngr-brand--product{display:block!important;padding:0!important;' +
        'min-height:auto!important;height:auto!important;overflow:hidden;text-decoration:none}' +
        '.ngr-brand--product img{display:block;width:100%!important;max-width:100%!important;' +
        'height:auto!important;max-height:none!important;transition:transform .25s ease}' +
        '.ngr-brand--product:hover img{transform:scale(1.03)}';
      document.head.appendChild(st);
    }
    grid.querySelectorAll('.ngr-brand').forEach(function (a) {
      var name = (a.textContent || '').trim();
      var top = BRAND_TOP[name];
      if (!top) return;
      var file = typeof top === 'string' ? top : top.img;
      if (typeof top === 'object' && top.brand) {
        a.setAttribute('href', '/?tfc_brand[2502703571]=' + encodeURIComponent(top.brand) + '&catalog=all#ngr-catalog');
        a.setAttribute('aria-label', 'Показать товары бренда ' + top.brand);
        name = top.brand;
      }
      a.classList.add('ngr-brand--product');
      a.innerHTML = '<img src="' + FILES + file + '" alt="' + name + '" loading="lazy">';
    });
  }

  /**
   * Поиск по каталогу на телефоне.
   *
   * Жалоба покупателя: нажимаешь лупу, начинаешь печатать — поле сбрасывается
   * и снова показывается лупа. Причина в самой Tilda: при событии resize она
   * пересобирает панель фильтров, а на телефоне resize вызывает появление
   * экранной клавиатуры. Введённый текст и фокус при этом теряются.
   *
   * Чиним, не трогая код Tilda: запоминаем, что поиск открыт и что в нём
   * набрано, и после пересборки возвращаем панель, текст и курсор. Если
   * покупатель закрыл поиск сам (крестик или пустой запрос) — не мешаем.
   */
  var SEARCH_INPUT = '.t-catalog__filter__search input, .t-store__filter__search input, ' +
    '.t-catalog__search-wrapper input, .js-catalog-filter-search input';
  var searchState = null;   // {value, width} пока покупатель работает с поиском

  function searchInput() { return document.querySelector(SEARCH_INPUT); }

  function initSearchGuard() {
    if (window.__ngrSearchGuard) return;
    window.__ngrSearchGuard = 1;

    document.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || !el.matches || !el.matches(SEARCH_INPUT)) return;
      searchState = el.value ? { value: el.value, width: window.innerWidth } : null;
    }, true);

    // Закрыл сам — забываем состояние и больше не возвращаем панель.
    document.addEventListener('click', function (e) {
      var el = e.target;
      if (el && el.closest && el.closest('.js-catalog-search-mob-close-btn, .t-catalog__filter__search-mob-close-btn')) {
        searchState = null;
      }
    }, true);
  }

  function fixSearch() {
    if (!searchState) return;
    // Ширина не менялась — значит панель схлопнулась не из-за поворота экрана,
    // а из-за клавиатуры: возвращаем всё как было.
    if (window.innerWidth !== searchState.width) { searchState = null; return; }
    var inp = searchInput();
    if (inp && document.activeElement === inp) return;      // всё на месте

    if (!inp || !inp.getBoundingClientRect().width) {
      var open = document.querySelector('.js-catalog-search-mob-btn');
      if (open && open.getBoundingClientRect().width) open.click();
      inp = searchInput();
    }
    if (!inp) return;
    if (inp.value !== searchState.value) {
      inp.value = searchState.value;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
  }

  /* ---------- Вход в кабинет ---------- */

  /**
   * Кнопка в шапке всегда говорила «Войти» — и до входа, и после. Покупатель
   * не понимал, вошёл он или нет (замечание Александра 07.08). Теперь после
   * входа на кнопке имя и кружок с инициалом, до входа — «Войти».
   *
   * Признак входа — токен Tilda Members; имя берём из профиля, который
   * Members кладёт в хранилище браузера.
   */
  var PROJECT = '27635446';

  function member() {
    var tok = '';
    try { tok = window.t_cart__getMembersToken ? (t_cart__getMembersToken() || '') : ''; } catch (e) {}
    if (!tok) return null;
    var name = '';
    try {
      var p = JSON.parse(localStorage.getItem('tilda_members_profile' + PROJECT) || '{}');
      name = String(p.name || p.login || '').trim();
    } catch (e) {}
    return { name: name };
  }

  function fixAccountButton() {
    var a = document.querySelector('.ngr-account-link');
    if (!a) return;
    var m = member();
    var want = m ? 'in' : 'out';
    if (a.getAttribute('data-ngr-auth') === want + (m && m.name ? m.name : '')) return;
    a.setAttribute('data-ngr-auth', want + (m && m.name ? m.name : ''));

    if (!document.getElementById('ngr-account-css')) {
      var st = document.createElement('style');
      st.id = 'ngr-account-css';
      st.textContent =
        '.ngr-account-link.ngr-account--in{background:#fff5ec;border-color:#f0c9a3}' +
        '.ngr-account-link .ngr-ava{display:inline-flex;align-items:center;justify-content:center;' +
        'width:22px;height:22px;border-radius:50%;background:#ff7a1a;color:#fff;font-size:11px;' +
        'font-weight:700;margin-right:7px;flex:0 0 22px}' +
        '.ngr-account-link .ngr-account-name{max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}';
      document.head.appendChild(st);
    }

    if (!m) {
      a.classList.remove('ngr-account--in');
      a.innerHTML = a.getAttribute('data-ngr-out') || a.innerHTML;
      return;
    }
    if (!a.getAttribute('data-ngr-out')) a.setAttribute('data-ngr-out', a.innerHTML);
    // Показываем имя, а фамилию опускаем — она не влезает и не нужна.
    var short = (m.name.split(/\s+/)[0] || 'Кабинет');
    var letter = (short.charAt(0) || 'К').toUpperCase();
    a.classList.add('ngr-account--in');
    a.innerHTML = '<span class="ngr-ava">' + letter + '</span>' +
      '<span class="ngr-account-name">' + short + '</span>';
    a.setAttribute('title', m.name + ' — личный кабинет');
    a.setAttribute('aria-label', 'Личный кабинет: ' + m.name);
  }

  window.NGR_MEMBER = member;
  window.NGR_LOGGED_IN = function () { return !!member(); };

  /* ---------- Отзывы покупателей ---------- */

  /**
   * Оценки и отзывы приходят из кабинета Ozon через интегратор: сводка на все
   * товары (звёзды в карточке каталога) и тексты по одному товару (когда
   * карточка раскрыта). Артикул на витрине — наш, у Ozon свой SKU, поэтому
   * нужна связка: её отдаёт тот же снимок остатков.
   */
  var rating = null;    // sku -> [сколько отзывов, средняя×10]
  var skuOf = null;     // артикул -> sku
  var texts = {};       // sku -> отзывы, подгружаются по требованию

  fetch(API + '/catalog/reviews')
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.rating) { rating = j.rating; apply(); } })
    .catch(function () {});

  function stars(v) {
    var out = '';
    for (var i = 1; i <= 5; i++) {
      var fill = v >= i ? 1 : (v > i - 1 ? (v - i + 1) : 0);
      out += '<span class="ngr-star"><span class="ngr-star__on" style="width:' +
        Math.round(fill * 100) + '%">★</span>★</span>';
    }
    return out;
  }

  function plural(n, one, few, many) {
    var a = n % 100, b = n % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }

  function reviewCss() {
    if (document.getElementById('ngr-rev-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-rev-css';
    st.textContent =
      '.ngr-star{position:relative;display:inline-block;color:#dfe3e8;font-size:15px;line-height:1;letter-spacing:1px}' +
      '.ngr-star__on{position:absolute;left:0;top:0;overflow:hidden;color:#ffab2e;white-space:nowrap}' +
      '.ngr-rate{display:flex;align-items:center;gap:6px;margin:6px 0 2px;font-size:13px;color:#6b7280}' +
      '.ngr-rate b{color:#111;font-weight:700;font-size:13px}' +
      '.ngr-revbox{margin:22px 0 6px;padding-top:18px;border-top:1px solid #eceff3}' +
      '.ngr-revbox h4{margin:0 0 14px;font-size:17px;font-weight:700;color:#111}' +
      '.ngr-revhead{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:16px}' +
      '.ngr-revbig{font-size:34px;font-weight:800;line-height:1;color:#111}' +
      '.ngr-revbars{flex:1;min-width:170px}' +
      '.ngr-revbar{display:flex;align-items:center;gap:8px;font-size:12px;color:#8a919b;margin:3px 0}' +
      '.ngr-revbar i{flex:1;height:6px;border-radius:4px;background:#eef1f5;overflow:hidden;font-style:normal}' +
      '.ngr-revbar i s{display:block;height:100%;background:#ffab2e;text-decoration:none}' +
      '.ngr-rev{padding:12px 0;border-top:1px solid #f2f4f7}' +
      '.ngr-rev:first-of-type{border-top:0}' +
      '.ngr-rev__top{display:flex;align-items:center;gap:9px;margin-bottom:5px}' +
      '.ngr-rev__date{font-size:12px;color:#9aa1ab}' +
      '.ngr-rev__text{font-size:14px;line-height:1.55;color:#2b2f36;white-space:pre-line}' +
      '.ngr-rev__more{display:inline-block;margin-top:10px;font-size:13px;color:#ff7a1a;cursor:pointer}' +
      '.ngr-revnote{font-size:12px;color:#9aa1ab;margin-top:12px}';
    document.head.appendChild(st);
  }

  /** Звёзды в карточке каталога — коротко, одной строкой. */
  function fixRatings() {
    if (!rating || !skuOf) return;
    reviewCss();
    document.querySelectorAll('.js-product').forEach(function (c) {
      if (c.getAttribute('data-ngr-rate') === '1') return;
      var a = article(c);
      if (!a) return;
      c.setAttribute('data-ngr-rate', '1');
      var r = rating[skuOf[a]];
      if (!r || !r[0]) return;
      var avg = r[1] / 10;
      var host = c.querySelector('.t-store__card__price-wrapper, .t-catalog__card__price, .js-store-price-wrapper');
      var box = document.createElement('div');
      box.className = 'ngr-rate';
      box.innerHTML = stars(avg) + '<b>' + avg.toFixed(1) + '</b><span>' + r[0] + ' ' +
        plural(r[0], 'отзыв', 'отзыва', 'отзывов') + '</span>';
      if (host && host.parentNode) host.parentNode.insertBefore(box, host);
      else c.appendChild(box);
    });
  }

  function renderReviews(box, sku, data) {
    var n = data.n || 0;
    if (!n) { box.innerHTML = ''; return; }
    var dist = [0, 0, 0, 0, 0];
    (data.list || []).forEach(function (r) { if (r.r >= 1 && r.r <= 5) dist[r.r - 1]++; });
    var shown = (data.list || []).length;
    var bars = '';
    for (var s = 5; s >= 1; s--) {
      var part = shown ? Math.round(dist[s - 1] / shown * 100) : 0;
      bars += '<div class="ngr-revbar">' + s + ' <i><s style="width:' + part + '%"></s></i></div>';
    }
    var list = (data.list || []).map(function (r) {
      return '<div class="ngr-rev"><div class="ngr-rev__top">' + stars(r.r) +
        '<span class="ngr-rev__date">' + (r.d || '').split('-').reverse().join('.') + '</span></div>' +
        '<div class="ngr-rev__text"></div></div>';
    }).join('');
    box.innerHTML =
      '<h4>Отзывы покупателей</h4>' +
      '<div class="ngr-revhead"><div><div class="ngr-revbig">' + (data.avg || 0).toFixed(1) + '</div>' +
      '<div>' + stars(data.avg || 0) + '</div>' +
      '<div class="ngr-rev__date">' + n + ' ' + plural(n, 'отзыв', 'отзыва', 'отзывов') + '</div></div>' +
      (shown ? '<div class="ngr-revbars">' + bars + '</div>' : '') + '</div>' + list +
      (shown ? '' : '<div class="ngr-revnote">Покупатели поставили оценки, но не оставили текст.</div>') +
      '<div class="ngr-revnote">Оценки и отзывы покупателей Ozon по этому товару.</div>';
    // Текст вставляем как текст, а не разметку: он приходит от покупателей.
    var nodes = box.querySelectorAll('.ngr-rev__text');
    (data.list || []).forEach(function (r, i) { if (nodes[i]) nodes[i].textContent = r.x || ''; });
  }

  /** Развёрнутая карточка товара: сводка, распределение оценок и тексты. */
  function fixPopupReviews() {
    if (!rating || !skuOf) return;
    var pop = document.querySelector('.t-popup_show .t-store__prod-popup__container, ' +
      '.t-store__prod-popup__container, .t-catalog__prod-popup__container');
    if (!pop || !pop.getBoundingClientRect().width) return;
    var a = article(pop);
    if (!a) return;
    var sku = skuOf[a];
    var box = pop.querySelector('.ngr-revbox');
    if (box && box.getAttribute('data-sku') === String(sku)) return;
    reviewCss();
    if (!box) {
      box = document.createElement('div');
      box.className = 'ngr-revbox';
      var host = pop.querySelector('.t-store__prod-popup__text, .t-store__prod-popup__info, .js-store-prod-text') || pop;
      host.appendChild(box);
    }
    box.setAttribute('data-sku', String(sku));
    var r = rating[sku];
    if (!r || !r[0]) { box.innerHTML = ''; return; }
    box.innerHTML = '<h4>Отзывы покупателей</h4><div class="ngr-revnote">Загружаем…</div>';
    if (texts[sku]) { renderReviews(box, sku, texts[sku]); return; }
    fetch(API + '/catalog/reviews?sku=' + encodeURIComponent(sku))
      .then(function (x) { return x.json(); })
      .then(function (j) { texts[sku] = j; if (box.getAttribute('data-sku') === String(sku)) renderReviews(box, sku, j); })
      .catch(function () { box.innerHTML = ''; });
  }

  /**
   * Заказ только для зарегистрированных (решение Александра 07.08).
   *
   * Держим проверку здесь, а не в виджете пунктов выдачи: тот включается
   * только на шаге с адресом, а запрет должен работать на всём оформлении.
   * Кнопку гасим и объясняем, почему, — молча запрещать нельзя.
   */
  function cartForms() {
    var out = [];
    document.querySelectorAll('.t-store__cart-form, .t706__cartwin form, form[name*="cart"]')
      .forEach(function (f) { if (f.getBoundingClientRect().width > 0) out.push(f); });
    return out;
  }

  function formSubmitBtn(f) {
    return f.querySelector('.t-submit, .t-form__submit button, button[type="submit"], input[type="submit"]');
  }

  /**
   * Кладём токен кабинета в форму заказа: интегратор подтвердит его у Tilda
   * и не примет заказ без входа. Запрет на сайте обходится, серверный — нет.
   */
  function stampToken(f) {
    var tok = '';
    try { tok = window.t_cart__getMembersToken ? (t_cart__getMembersToken() || '') : ''; } catch (e) {}
    var input = f.querySelector('input[name="ngmember"]');
    if (!tok) { if (input) input.parentNode.removeChild(input); return; }
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'ngmember';
      f.appendChild(input);
    }
    if (input.value !== tok) input.value = tok;
  }

  function fixAuthGate() {
    var ok = !!member();
    cartForms().forEach(function (f) {
      stampToken(f);
      var btn = formSubmitBtn(f);
      var box = f.querySelector('.ngr-auth-stopper');
      if (ok) {
        if (box) box.parentNode.removeChild(box);
        if (btn && btn.getAttribute('data-ngr-auth-blocked') === '1') {
          btn.removeAttribute('data-ngr-auth-blocked');
          // Не воскрешаем кнопку, если её погасил виджет доставки.
          if (btn.getAttribute('data-ngpvz-blocked') !== '1') {
            btn.disabled = false;
            btn.style.opacity = '';
            btn.style.cursor = '';
          }
        }
        return;
      }
      if (btn) {
        btn.setAttribute('data-ngr-auth-blocked', '1');
        btn.disabled = true;
        btn.style.opacity = '0.45';
        btn.style.cursor = 'not-allowed';
      }
      if (!box) {
        box = document.createElement('div');
        box.className = 'ngr-auth-stopper';
        box.style.cssText = 'margin:12px 0;padding:14px 16px;border:1px solid #f0c9a3;' +
          'background:#fff7ef;border-radius:12px;color:#7a4a12;font-size:14px;line-height:1.5';
        box.innerHTML = '<b>Заказ оформляется из личного кабинета.</b><br>' +
          'Так заказ, документы и история покупок останутся у вас под рукой.<br>' +
          '<a href="#openmembersbar" style="display:inline-block;margin-top:8px;padding:9px 16px;' +
          'background:#ff7a1a;color:#fff;border-radius:9px;font-weight:700;text-decoration:none">' +
          'Войти или зарегистрироваться</a>';
        if (btn && btn.parentNode) btn.parentNode.insertBefore(box, btn);
        else f.insertBefore(box, f.firstChild);
      }
    });
  }

  // Последний рубеж: если кнопку кто-то включит обратно, отправку всё равно
  // не пропустим.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.matches || !f.matches('.t-store__cart-form, .t706__cartwin form, form[name*="cart"]')) return;
    if (member()) return;
    e.preventDefault();
    e.stopPropagation();
    fixAuthGate();
    var box = f.querySelector('.ngr-auth-stopper');
    if (box) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, true);

  function apply() {
    fixPopup(); fixCards(); fixCart(); fixDupDelivery(); fixUnits(); fixBrands();
    initSearchGuard(); fixSearch(); fixAccountButton(); fixAuthGate();
    fixRatings(); fixPopupReviews();
  }

  apply();
  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', apply);
  new MutationObserver(function () { apply(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
