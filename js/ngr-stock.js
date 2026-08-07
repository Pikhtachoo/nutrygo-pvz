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
    var m = el && (el.textContent || '').match(/(\d{3,})/);
    if (m) return m[1];
    // В раскрытой карточке артикула в отдельном поле нет — в этой вёрстке под
    // «__sku» лежит бренд. Берём из подписи «Артикул: 31983».
    m = (root.textContent || '').match(/Артикул:\s*([\w-]*\d[\w-]*)/i);
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
    // Вошедшего ведём в наш кабинет, а не в кабинет Tilda.
    if (!a.getAttribute('data-ngr-cab')) {
      a.setAttribute('data-ngr-cab', '1');
      a.addEventListener('click', function (e) {
        if (!member()) return;
        e.preventDefault();
        e.stopPropagation();
        openCabinet();
      }, true);
    }
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
      // Звёзды
      '.ngr-star{position:relative;display:inline-block;color:#dde1e6;font-size:15px;line-height:1;letter-spacing:1px}' +
      '.ngr-star__on{position:absolute;left:0;top:0;overflow:hidden;color:#ffab2e;white-space:nowrap}' +
      '.ngr-rate{display:flex;align-items:center;gap:6px;margin:6px 0 2px;font-size:13px;color:#6b7280}' +
      '.ngr-rate b{color:#111;font-weight:700}' +
      // Блок отзывов. Цвета и размеры задаём жёстко: вокруг стоит типографика
      // Tilda, из-за неё текст отзыва красился в оранжевый, как ссылка.
      '.ngr-revbox{margin:26px 0;padding:22px;border:1px solid #e8ecf1;border-radius:16px;' +
      'background:#fff;font-family:inherit;box-sizing:border-box}' +
      '.ngr-revbox *{box-sizing:border-box}' +
      '.ngr-revbox h4{margin:0 0 18px;font-size:19px;font-weight:800;color:#14171c;letter-spacing:-.2px}' +
      '.ngr-revhead{display:flex;align-items:center;gap:24px;flex-wrap:wrap;padding-bottom:18px;' +
      'margin-bottom:6px;border-bottom:1px solid #f0f2f5}' +
      '.ngr-revscore{text-align:center;min-width:92px}' +
      '.ngr-revbig{font-size:42px;font-weight:800;line-height:1;color:#14171c;letter-spacing:-1px}' +
      '.ngr-revscore .ngr-star{font-size:17px}' +
      '.ngr-revcount{font-size:13px;color:#8a919b;margin-top:4px}' +
      '.ngr-revbars{flex:1;min-width:190px}' +
      '.ngr-revbar{display:flex;align-items:center;gap:9px;font-size:12px;color:#8a919b;margin:4px 0}' +
      '.ngr-revbar u{width:26px;text-decoration:none;color:#6b7280;text-align:right}' +
      '.ngr-revbar i{flex:1;height:7px;border-radius:5px;background:#f0f2f5;overflow:hidden;font-style:normal}' +
      '.ngr-revbar i s{display:block;height:100%;background:#ffab2e;text-decoration:none}' +
      '.ngr-revbar em{width:24px;font-style:normal;color:#a6adb6}' +
      // Отдельный отзыв
      '.ngr-rev{display:flex;gap:12px;padding:16px 0;border-top:1px solid #f0f2f5}' +
      '.ngr-rev__ava{flex:0 0 38px;width:38px;height:38px;border-radius:50%;background:#f3f5f8;' +
      'display:flex;align-items:center;justify-content:center;color:#9aa1ab;font-size:17px}' +
      '.ngr-rev__body{flex:1;min-width:0}' +
      '.ngr-rev__top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px}' +
      '.ngr-rev__who{font-size:14px;font-weight:700;color:#14171c}' +
      '.ngr-rev__date{font-size:12px;color:#a6adb6}' +
      '.ngr-rev__ok{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;' +
      'color:#1a8f4c;background:#eaf7ef;border-radius:20px;padding:3px 9px}' +
      '.ngr-rev__text{font-size:14.5px;line-height:1.6;color:#2b2f36!important;white-space:pre-line;margin-top:6px}' +
      '.ngr-rev__pics{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}' +
      '.ngr-rev__pics a{display:block;width:72px;height:72px;border-radius:10px;overflow:hidden;' +
      'background:#f3f5f8;border:1px solid #eceff3}' +
      '.ngr-rev__pics img{width:100%;height:100%;object-fit:cover;display:block}' +
      '.ngr-revmore{display:block;width:100%;margin-top:16px;padding:12px;border:1px solid #e3e8ee;' +
      'background:#fff;border-radius:12px;font-size:14px;font-weight:700;color:#14171c;cursor:pointer}' +
      '.ngr-revmore:hover{background:#f8fafc}' +
      '.ngr-revnote{font-size:12px;color:#a6adb6;margin-top:14px;line-height:1.5}' +
      // Телефон: крупные отзывы в одну колонку, оценка над шкалами
      '@media(max-width:640px){' +
      '.ngr-revbox{padding:16px;border-radius:14px;margin:20px 0}' +
      '.ngr-revbox h4{font-size:17px;margin-bottom:14px}' +
      '.ngr-revhead{gap:14px}' +
      '.ngr-revscore{min-width:0;text-align:left;display:flex;align-items:center;gap:12px}' +
      '.ngr-revbig{font-size:34px}' +
      '.ngr-revbars{flex:1 0 100%;min-width:0}' +
      '.ngr-rev{gap:10px;padding:14px 0}' +
      '.ngr-rev__ava{flex:0 0 32px;width:32px;height:32px;font-size:15px}' +
      '.ngr-rev__text{font-size:14px}' +
      '.ngr-rev__pics a{width:64px;height:64px}}';
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

  /* ---------- Свидетельство о госрегистрации (СГР) ---------- */

  /**
   * У БАДов есть свидетельство о государственной регистрации. Номер —
   * подтверждение, что товар прошёл проверку, и покупателю его видно ценно
   * (запрос Александра 08.08). Справочник присылает Александр файлом,
   * интегратор его раздаёт, здесь мы ставим отметку на карточке и
   * показываем номер в развёрнутой карточке.
   */
  var sgrMap = null;

  fetch(API + '/catalog/sgr')
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.sgr) { sgrMap = j.sgr; apply(); } })
    .catch(function () {});

  function sgrCss() {
    if (document.getElementById('ngr-sgr-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-sgr-css';
    st.textContent =
      '.ngr-sgr{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;' +
      'color:#1a8f4c;background:#eaf7ef;border-radius:20px;padding:4px 10px;margin:4px 0;white-space:nowrap}' +
      '.ngr-sgr__num{display:block;margin-top:8px;font-size:13px;color:#6b7280}' +
      '.ngr-sgr__num b{color:#14171c;font-weight:600}';
    document.head.appendChild(st);
  }

  function fixSgr() {
    if (!sgrMap) return;
    sgrCss();
    // Отметка в карточке каталога
    document.querySelectorAll('.js-product').forEach(function (c) {
      if (c.getAttribute('data-ngr-sgr') === '1') return;
      var a = article(c);
      if (!a) return;
      c.setAttribute('data-ngr-sgr', '1');
      if (!sgrMap[a]) return;
      var host = c.querySelector('.js-catalog-price-wrapper, .t-catalog__card__price-wrapper');
      if (!host || !host.parentNode) return;
      var b = document.createElement('span');
      b.className = 'ngr-sgr';
      b.textContent = '✓ Проверен: СГР есть';
      b.title = 'Свидетельство о государственной регистрации № ' + sgrMap[a];
      host.parentNode.insertBefore(b, host);
    });

    // Номер в развёрнутой карточке
    var pop = document.querySelector('.t-popup_show .t-catalog__prod-popup__container, ' +
      '.t-catalog__prod-popup__container');
    if (!pop || !pop.getBoundingClientRect().width) return;
    var art = article(pop);
    if (!art) return;
    var box = pop.querySelector('.ngr-sgr__num');
    var num = sgrMap[art];
    if (!num) { if (box) box.parentNode.removeChild(box); return; }
    if (box && box.getAttribute('data-art') === art) return;
    if (!box) {
      box = document.createElement('div');
      box.className = 'ngr-sgr__num';
      var anchor = pop.querySelector('.ngr-descwrap') || pop.querySelector('.js-catalog-prod-text');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor);
      else pop.appendChild(box);
    }
    box.setAttribute('data-art', art);
    box.innerHTML = '<span class="ngr-sgr">✓ Проверен: СГР есть</span><br>' +
      'Свидетельство о государственной регистрации: <b></b>';
    box.querySelector('b').textContent = num;
  }

  /* ---------- Своё окно товара ---------- */

  /**
   * Собственная карточка товара.
   *
   * Каталог Tilda держит в памяти лишь несколько карточек и догружает
   * остальные по прокрутке — открыть товар с полки через него не выходило
   * (четыре неудачных попытки, 08.08). Поэтому собираем окно сами из данных
   * интегратора: фотографии Ozon, цена, отзывы, СГР, остаток и сроки
   * доставки приходят одним ответом.
   *
   * Открывается откуда угодно: с полки, по ссылке вида ?ngprod=31983.
   */
  var prodCache = {};

  function prodCss() {
    if (document.getElementById('ngr-prod-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-prod-css';
    st.textContent =
      '.ngr-pw{position:fixed;inset:0;z-index:100000;display:none}' +
      '.ngr-pw_open{display:block}' +
      '.ngr-pw__bg{position:absolute;inset:0;background:rgba(20,23,28,.55)}' +
      '.ngr-pw__win{position:absolute;inset:24px;max-width:1180px;margin:0 auto;background:#fff;' +
      'border-radius:20px;overflow:auto;-webkit-overflow-scrolling:touch}' +
      '.ngr-pw__x{position:sticky;top:0;float:right;margin:12px 12px 0 0;width:38px;height:38px;' +
      'border-radius:50%;border:0;background:#f2f4f7;color:#14171c;font-size:19px;cursor:pointer;z-index:2}' +
      '.ngr-pw__x:hover{background:#e7eaee}' +
      '.ngr-pd{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:34px;padding:26px 30px 34px}' +
      '.ngr-pd__gal{display:flex;gap:12px}' +
      '.ngr-pd__thumbs{display:flex;flex-direction:column;gap:8px;flex:0 0 62px}' +
      '.ngr-pd__thumbs i{display:block;width:62px;height:62px;border-radius:10px;border:1px solid #e8ecf1;' +
      'background:#fff center/contain no-repeat;cursor:pointer}' +
      '.ngr-pd__thumbs i.on{border-color:#4984c4;box-shadow:0 0 0 2px rgba(73,132,196,.22)}' +
      '.ngr-pd__big{flex:1;min-width:0;aspect-ratio:1/1;border-radius:16px;border:1px solid #eef1f5;' +
      'background:#fff center/contain no-repeat}' +
      '.ngr-pd h3{margin:0 0 8px;font-size:22px;line-height:1.32;font-weight:700;color:#14171c}' +
      '.ngr-pd__meta{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:13px;color:#8a919b;margin-bottom:10px}' +
      '.ngr-pd__meta b{color:#14171c}' +
      '.ngr-pd__box{border:1px solid #e8ecf1;border-radius:16px;padding:16px 18px;margin:14px 0}' +
      '.ngr-pd__price{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
      '.ngr-pd__now{background:#4984c4;color:#fff;font-size:26px;font-weight:800;padding:7px 14px;border-radius:12px;letter-spacing:-.5px}' +
      '.ngr-pd__old{color:#a6adb6;font-size:16px;font-weight:600;text-decoration:line-through}' +
      '.ngr-pd__left{font-size:13px;color:#1a8f4c;font-weight:700;margin-top:10px}' +
      '.ngr-pd__buy{display:block;width:100%;margin-top:14px;padding:15px;border:0;border-radius:12px;' +
      'background:#ff7a1a;color:#fff;font-size:16px;font-weight:700;cursor:pointer}' +
      '.ngr-pd__buy:hover{background:#f06f10}' +
      '.ngr-pd__buy[disabled]{background:#c8ced6;cursor:not-allowed}' +
      '.ngr-pd__full{grid-column:1/-1;padding:0 30px 30px}' +
      '@media(max-width:900px){' +
      '.ngr-pw__win{inset:0;border-radius:0}' +
      '.ngr-pd{grid-template-columns:1fr;gap:20px;padding:12px 16px 24px}' +
      '.ngr-pd__gal{flex-direction:column-reverse}' +
      '.ngr-pd__thumbs{flex-direction:row;flex:0 0 auto;overflow-x:auto}' +
      '.ngr-pd h3{font-size:19px}' +
      '.ngr-pd__now{font-size:23px}' +
      '.ngr-pd__full{padding:0 16px 24px}}';
    document.head.appendChild(st);
  }

  function prodWin() {
    var w = document.querySelector('.ngr-pw');
    if (w) return w;
    prodCss();
    w = document.createElement('div');
    w.className = 'ngr-pw';
    w.innerHTML = '<div class="ngr-pw__bg"></div><div class="ngr-pw__win">' +
      '<button type="button" class="ngr-pw__x" aria-label="Закрыть">✕</button>' +
      '<div class="ngr-pw__body"></div></div>';
    w.querySelector('.ngr-pw__bg').addEventListener('click', closeProduct);
    w.querySelector('.ngr-pw__x').addEventListener('click', closeProduct);
    document.body.appendChild(w);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeProduct();
    });
    return w;
  }

  function closeProduct() {
    var w = document.querySelector('.ngr-pw');
    if (w) w.classList.remove('ngr-pw_open');
    document.body.style.removeProperty('overflow');
    if (/[?&]ngprod=/.test(location.search)) {
      history.replaceState(null, '', location.pathname);
    }
  }

  function addToCart(d) {
    var pk = String(d.pack || '').split('|');
    var item = {
      name: d.title, price: d.price, quantity: 1, inv: d.left || 1,
      uid: d.uid, lid: d.uid, gen_uid: d.uid,
      sku: d.art, img: (d.photos || [])[0] || '',
      url: d.url || '', recid: '2502703571',
      portion: d.portion || '1', unit: d.unit || 'шт.',
      pack_label: pk[0] || '', pack_x: pk[1] || '', pack_y: pk[2] || '',
      pack_z: pk[3] || '', pack_m: pk[4] || '',
      amount: d.price
    };
    try {
      if (window.tcart__addProduct) { tcart__addProduct(item); return true; }
    } catch (e) {}
    return false;
  }

  function renderProduct(d) {
    var body = prodWin().querySelector('.ngr-pw__body');
    var photos = (d.photos || []).slice(0, 8);
    var thumbs = photos.map(function (u, i) {
      return '<i data-i="' + i + '" class="' + (i ? '' : 'on') + '" style="background-image:url(\'' + u + '\')"></i>';
    }).join('');

    body.innerHTML =
      '<div class="ngr-pd">' +
      '<div class="ngr-pd__gal">' +
      (photos.length > 1 ? '<div class="ngr-pd__thumbs">' + thumbs + '</div>' : '') +
      '<div class="ngr-pd__big" style="background-image:url(\'' + (photos[0] || '') + '\')"></div>' +
      '</div>' +
      '<div class="ngr-pd__info">' +
      '<h3></h3>' +
      '<div class="ngr-pd__meta"><span>Артикул: ' + d.art + '</span>' +
      (d.reviews && d.reviews.n ? '<span>' + stars(d.reviews.avg) + ' <b>' + d.reviews.avg.toFixed(1) + '</b> · ' +
        d.reviews.n + ' ' + plural(d.reviews.n, 'отзыв', 'отзыва', 'отзывов') + '</span>' : '') + '</div>' +
      (d.sgr ? '<span class="ngr-sgr">✓ Проверен: СГР есть</span>' +
        '<div class="ngr-sgr__num">Свидетельство о государственной регистрации: <b>' + d.sgr + '</b></div>' : '') +
      '<div class="ngr-pd__box">' +
      '<div class="ngr-pd__price"><span class="ngr-pd__now">' + money(d.price) + '</span>' +
      (d.old ? '<span class="ngr-pd__old">' + money(d.old) + '</span>' : '') +
      (d.off ? '<span class="ngr-off">−' + d.off + '%</span>' : '') + '</div>' +
      (d.left >= 4 ? '<div class="ngr-pd__left">В наличии</div>' :
        '<div class="ngr-pd__left" style="color:#a11">Сейчас недоступен</div>') +
      '<button type="button" class="ngr-pd__buy"' + (d.left >= 4 ? '' : ' disabled') + '>В корзину</button>' +
      '<button type="button" class="ngr-pd__fav' + (favHas(d.art) ? ' on' : '') + '">' +
      (favHas(d.art) ? '♥ В избранном' : '♡ В избранное') + '</button>' +
      '</div></div>' +
      '<div class="ngr-pd__full"><div class="ngr-pd__desc"></div><div class="ngr-pd__rev"></div></div>' +
      '</div>';

    body.querySelector('h3').textContent = d.title;

    // Галерея
    var big = body.querySelector('.ngr-pd__big');
    body.querySelectorAll('.ngr-pd__thumbs i').forEach(function (t) {
      t.addEventListener('click', function () {
        var i = Number(t.getAttribute('data-i')) || 0;
        big.style.backgroundImage = 'url("' + photos[i] + '")';
        body.querySelectorAll('.ngr-pd__thumbs i').forEach(function (x) { x.className = ''; });
        t.className = 'on';
      });
    });

    // Кнопка покупки
    var buy = body.querySelector('.ngr-pd__buy');
    if (buy) buy.addEventListener('click', function () {
      if (addToCart(d)) {
        buy.textContent = '✓ В корзине';
        setTimeout(function () { buy.textContent = 'В корзину'; }, 2000);
      } else {
        buy.textContent = 'Не удалось добавить';
      }
    });

    favCss();
    var fav = body.querySelector('.ngr-pd__fav');
    if (fav) fav.addEventListener('click', function () {
      var on = favToggle(d.art);
      fav.className = 'ngr-pd__fav' + (on ? ' on' : '');
      fav.textContent = on ? '♥ В избранном' : '♡ В избранное';
      fixFav();
    });

    // Описание и характеристики — тем же видом, что в каталоге
    var descHost = body.querySelector('.ngr-pd__desc');
    if (d.text) {
      descCss();
      var lines = String(d.text).split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
      var specs = [];
      while (lines.length) {
        var m = lines[lines.length - 1].match(/^([^:]{2,45}):\s*(.+)$/);
        if (!m || m[1].split(' ').length > 6) break;
        specs.unshift([m[1], m[2]]);
        lines.pop();
      }
      if (lines.length) {
        var a1 = accordion('Описание', false);
        var b1 = a1.querySelector('.ngr-acc__body');
        lines.join('\n\n').split('\n\n').forEach(function (p) {
          var el = document.createElement('p'); el.textContent = p; b1.appendChild(el);
        });
        descHost.appendChild(a1);
      }
      if (specs.length) {
        var a2 = accordion('Характеристики', true);
        var tb = document.createElement('table'); tb.className = 'ngr-spec';
        specs.forEach(function (s) {
          var tr = document.createElement('tr');
          var t1 = document.createElement('td'); t1.textContent = s[0];
          var t2 = document.createElement('td'); t2.textContent = s[1];
          tr.appendChild(t1); tr.appendChild(t2); tb.appendChild(tr);
        });
        a2.querySelector('.ngr-acc__body').appendChild(tb);
        descHost.appendChild(a2);
      }
    }

    // Отзывы — тем же блоком, что в каталоге
    if (d.reviews && d.reviews.n) {
      reviewCss();
      var rb = document.createElement('div');
      rb.className = 'ngr-revbox';
      body.querySelector('.ngr-pd__rev').appendChild(rb);
      renderReviews(rb, d.art, d.reviews);
    }
  }

  function openProduct(art) {
    var w = prodWin();
    w.classList.add('ngr-pw_open');
    document.body.style.setProperty('overflow', 'hidden');
    w.querySelector('.ngr-pw__win').scrollTop = 0;
    history.replaceState(null, '', location.pathname + '?ngprod=' + encodeURIComponent(art));
    if (prodCache[art]) { renderProduct(prodCache[art]); return; }
    w.querySelector('.ngr-pw__body').innerHTML =
      '<div style="padding:60px 30px;text-align:center;color:#8a919b">Загружаем карточку…</div>';
    fetch(API + '/catalog/product?offer=' + encodeURIComponent(art))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.error) throw new Error('нет данных');
        prodCache[art] = j;
        renderProduct(j);
      })
      .catch(function () {
        w.querySelector('.ngr-pw__body').innerHTML =
          '<div style="padding:60px 30px;text-align:center;color:#a11">Не удалось загрузить карточку товара.</div>';
      });
  }

  window.NGR_OPEN_PRODUCT = openProduct;

  /**
   * Каталог тоже открывает наше окно (решение Александра 08.08): вид товара
   * становится одинаковым везде, и мы перестаём зависеть от всплывающей
   * карточки Tilda.
   *
   * Не перехватываем то, что должно работать по-своему: кнопку «В корзину»,
   * счётчик количества и точки галереи под фотографией.
   */
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.closest) return;
    if (el.closest('.ngr-pw')) return;                 // клик внутри нашего окна
    var card = el.closest('.js-product');
    if (!card) return;
    if (el.closest('.ngr-gal')) return;                // точки галереи
    if (el.closest('.ng2-brand-buy, [class*="cart"], [class*="quantity"], input, select')) return;
    var txt = (el.textContent || '').trim();
    if (/^(в корзину|отменить|\+|−|-)$/i.test(txt)) return;
    var art = article(card);
    if (!art) return;
    e.preventDefault();
    e.stopPropagation();
    openProduct(art);
  }, true);

  // Прямая ссылка на товар
  (function () {
    var m = location.search.match(/[?&]ngprod=([\w-]+)/);
    if (!m) return;
    // Ждём, пока страница отрисуется. Раньше окно открывалось через 400 мс
    // и накрывало ещё не собранную страницу, а блокировка прокрутки могла
    // остаться на полупустой странице (замечание Александра 08.08).
    var go = function () { setTimeout(function () { openProduct(m[1]); }, 600); };
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go);
  })();

  // Если окна нет, прокрутка страницы обязана быть свободной. Страховка
  // от «белой страницы»: что бы ни случилось, сайт не должен остаться
  // заблокированным.
  setInterval(function () {
    var open = document.querySelector('.ngr-pw_open');
    if (!open && document.body.style.overflow === 'hidden') {
      document.body.style.removeProperty('overflow');
    }
  }, 1000);

  /* ---------- Личный кабинет ---------- */

  /**
   * Свой кабинет на основном сайте.
   *
   * Кабинет Tilda переделать нельзя: страницы /members/ — отдельное
   * приложение, туда не попадают ни наши скрипты, ни стили (проверено
   * 08.08). Поэтому собираем свой, а данные покупателя берём прямо
   * в его браузере у Tilda: токен кабинета действует только там, наружу
   * Tilda его не признаёт. Персональные данные к нам не попадают.
   */
  var TP = '27635446';

  function memberToken() {
    try { return (window.t_cart__getMembersToken && t_cart__getMembersToken()) || ''; } catch (e) { return ''; }
  }

  function tildaPost(path, extra) {
    var body = 'projectid=' + TP + '&token=' + encodeURIComponent(memberToken()) + (extra || '');
    return fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
    }).then(function (r) { return r.json(); });
  }

  function cabCss() {
    if (document.getElementById('ngr-cab-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-cab-css';
    st.textContent =
      '.ngr-cab{display:grid;grid-template-columns:236px minmax(0,1fr);gap:26px;padding:26px 30px 40px}' +
      '.ngr-cab__side{position:sticky;top:16px;align-self:start}' +
      '.ngr-cab__me{display:flex;align-items:center;gap:12px;margin-bottom:18px}' +
      '.ngr-cab__ava{width:48px;height:48px;border-radius:50%;background:#4984c4;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800}' +
      '.ngr-cab__name{font-size:16px;font-weight:700;color:#14171c;line-height:1.2}' +
      '.ngr-cab__mail{font-size:12px;color:#8a919b;word-break:break-all}' +
      '.ngr-cab__nav b{display:block;padding:11px 13px;border-radius:10px;font-size:14.5px;' +
      'font-weight:500;color:#14171c;cursor:pointer}' +
      '.ngr-cab__nav b:hover{background:#f5f7fa}' +
      '.ngr-cab__nav b.on{background:#eef4fb;color:#2f6ba8;font-weight:700}' +
      '.ngr-cab h2{margin:0 0 16px;font-size:26px;font-weight:800;letter-spacing:-.6px;color:#14171c}' +
      '.ngr-cab__card{border:1px solid #e8ecf1;border-radius:16px;padding:18px;margin-bottom:14px}' +
      '.ngr-cab__row{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:10px}' +
      '.ngr-cab__st{font-size:13px;font-weight:700;color:#1a8f4c}' +
      '.ngr-cab__sum{font-size:18px;font-weight:800;color:#14171c}' +
      '.ngr-cab__items{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}' +
      '.ngr-cab__it{width:74px;text-align:center;cursor:pointer}' +
      '.ngr-cab__it i{display:block;width:74px;height:74px;border-radius:10px;border:1px solid #eef1f5;' +
      'background:#fff center/contain no-repeat}' +
      '.ngr-cab__it span{display:block;font-size:11px;color:#6b7280;margin-top:4px;overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap}' +
      '.ngr-cab__empty{padding:40px 20px;text-align:center;color:#8a919b;border:1px dashed #dfe4ea;border-radius:16px}' +
      '.ngr-cab__field{margin-bottom:14px}' +
      '.ngr-cab__field u{display:block;text-decoration:none;font-size:12px;color:#8a919b;margin-bottom:3px}' +
      '.ngr-cab__field b{font-size:15px;color:#14171c;font-weight:600}' +
      '@media(max-width:860px){' +
      '.ngr-cab{grid-template-columns:1fr;gap:16px;padding:12px 16px 26px}' +
      '.ngr-cab__side{position:static}' +
      '.ngr-cab__nav{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}' +
      '.ngr-cab__nav b{white-space:nowrap;padding:9px 14px;border:1px solid #e8ecf1}' +
      '.ngr-cab h2{font-size:21px}}';
    document.head.appendChild(st);
  }

  var cabData = { profile: null, dash: null };

  /** Статус заказа Tilda приходит то строкой, то объектом — приводим к тексту. */
  function orderStatus(o) {
    var s = o.status_name || o.status || o.state || '';
    if (s && typeof s === 'object') s = s.name || s.title || s.text || s.value || '';
    return String(s || 'Оформлен');
  }

  function cabSection(name) {
    var host = document.querySelector('.ngr-cab__main');
    if (!host) return;
    document.querySelectorAll('.ngr-cab__nav b').forEach(function (b) {
      b.className = b.getAttribute('data-s') === name ? 'on' : '';
    });
    var d = cabData.dash || {};
    var p = cabData.profile || {};

    if (name === 'orders') {
      var orders = d.last_orders || [];
      host.innerHTML = '<h2>Заказы</h2>' + (orders.length ? '' :
        '<div class="ngr-cab__empty">Здесь появятся ваши заказы с сайта.<br>' +
        'Заказы, оформленные до входа в кабинет, сюда не попадают.</div>');
      orders.forEach(function (o) {
        var c = document.createElement('div');
        c.className = 'ngr-cab__card';
        c.innerHTML = '<div class="ngr-cab__row"><div><b>Заказ № ' + (o.id || o.orderid || '') + '</b>' +
          '<div class="ngr-cab__mail">' + String(o.date || o.created || '').slice(0, 16) + '</div></div>' +
          '<div style="text-align:right"><div class="ngr-cab__sum">' + money(Number(o.amount) || 0) + '</div>' +
          '<div class="ngr-cab__st">' + orderStatus(o) + '</div></div></div>';
        host.appendChild(c);
      });
      return;
    }

    if (name === 'purchases') {
      var buys = d.last_purchases || [];
      host.innerHTML = '<h2>Купленные товары</h2>' + (buys.length ? '' :
        '<div class="ngr-cab__empty">Здесь появятся товары из ваших заказов.</div>');
      if (buys.length) {
        var box = document.createElement('div');
        box.className = 'ngr-cab__items';
        buys.forEach(function (b) {
          var el = document.createElement('div');
          el.className = 'ngr-cab__it';
          el.innerHTML = '<i style="background-image:url(\'' + (b.img || '') + '\')"></i><span></span>';
          el.querySelector('span').textContent = b.name || '';
          if (b.sku) el.addEventListener('click', function () { openProduct(String(b.sku)); });
          box.appendChild(el);
        });
        host.appendChild(box);
      }
      return;
    }

    if (name === 'fav') {
      var list = favList();
      host.innerHTML = '<h2>Избранное</h2>' + (list.length ? '' :
        '<div class="ngr-cab__empty">Пока пусто. Нажмите ♡ на карточке товара, чтобы сохранить его сюда.</div>');
      if (list.length) {
        var fb = document.createElement('div');
        fb.className = 'ngr-shelf';
        host.appendChild(fb);
        Promise.all(list.map(function (a) {
          return fetch(API + '/catalog/product?offer=' + encodeURIComponent(a))
            .then(function (r) { return r.json(); }).catch(function () { return null; });
        })).then(function (arr) {
          arr.filter(Boolean).filter(function (x) { return !x.error; }).forEach(function (x) {
            fb.appendChild(shelfCard({
              art: x.art, title: x.title, img: (x.photos || [])[0] || '',
              price: x.price, old: x.old, off: x.off,
              n: x.reviews ? x.reviews.n : 0, avg: x.reviews ? x.reviews.avg : 0, url: ''
            }));
          });
        });
      }
      return;
    }

    if (name === 'docs') {
      host.innerHTML = '<h2>Документы на товары</h2>' +
        '<div class="ngr-cab__card">Каждый товар в каталоге отмечен свидетельством ' +
        'о государственной регистрации. Номер виден в карточке товара — откройте её и ' +
        'найдите отметку «Проверен: СГР есть».</div>' +
        '<div class="ngr-cab__card"><b>Всего товаров со свидетельством: ' +
        (sgrMap ? Object.keys(sgrMap).length : '…') + '</b></div>';
      return;
    }

    host.innerHTML = '<h2>Профиль</h2>' +
      '<div class="ngr-cab__card">' +
      '<div class="ngr-cab__field"><u>Имя</u><b>' + (p.name || '—') + '</b></div>' +
      '<div class="ngr-cab__field"><u>Электронная почта</u><b>' + (p.login || '—') + '</b></div>' +
      '<div class="ngr-cab__field"><u>Телефон</u><b>' + (p.phone || '—') + '</b></div>' +
      '</div>' +
      '<div class="ngr-cab__card">Изменить данные и пароль можно в ' +
      '<a href="/members/profile/" style="color:#2f6ba8">настройках профиля</a>.</div>';
  }

  function openCabinet() {
    if (!memberToken()) { location.href = '#openmembersbar'; return; }
    cabCss();
    var w = prodWin();
    w.classList.add('ngr-pw_open');
    document.body.style.setProperty('overflow', 'hidden');
    var body = w.querySelector('.ngr-pw__body');
    body.innerHTML = '<div class="ngr-cab"><div class="ngr-cab__side">' +
      '<div class="ngr-cab__me"><div class="ngr-cab__ava">·</div><div>' +
      '<div class="ngr-cab__name">Личный кабинет</div><div class="ngr-cab__mail"></div></div></div>' +
      '<div class="ngr-cab__nav">' +
      '<b data-s="orders" class="on">Заказы</b>' +
      '<b data-s="purchases">Купленные товары</b>' +
      '<b data-s="fav">Избранное</b>' +
      '<b data-s="docs">Документы</b>' +
      '<b data-s="profile">Профиль</b>' +
      '</div></div><div class="ngr-cab__main"><div class="ngr-cab__empty">Загружаем…</div></div></div>';

    body.querySelectorAll('.ngr-cab__nav b').forEach(function (b) {
      b.addEventListener('click', function () { cabSection(b.getAttribute('data-s')); });
    });

    Promise.all([
      tildaPost('https://members.tildaapi.com/api/getprofile/').catch(function () { return null; }),
      tildaPost('https://store.tildaapi.com/api/orders/getdashboard/').catch(function () { return null; })
    ]).then(function (res) {
      cabData.profile = (res[0] && res[0].data) || {};
      cabData.dash = res[1] || {};
      var nm = cabData.profile.name || 'Покупатель';
      body.querySelector('.ngr-cab__ava').textContent = (nm.charAt(0) || 'П').toUpperCase();
      body.querySelector('.ngr-cab__name').textContent = nm;
      body.querySelector('.ngr-cab__mail').textContent = cabData.profile.login || '';
      cabSection('orders');
    });
  }

  window.NGR_OPEN_CABINET = openCabinet;

  /* ---------- Избранное ---------- */

  /**
   * Избранное храним в браузере покупателя: отдельного хранилища на нашей
   * стороне не требуется, а личные данные никуда не уходят.
   */
  function favList() {
    try { return JSON.parse(localStorage.getItem('ngr_fav') || '[]'); } catch (e) { return []; }
  }
  function favHas(a) { return favList().indexOf(String(a)) > -1; }

  function favCss() {
    if (document.getElementById('ngr-fav-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-fav-css';
    st.textContent =
      '.ngr-fav{position:absolute;top:10px;right:10px;z-index:4;width:34px;height:34px;border:0;' +
      'border-radius:50%;background:rgba(255,255,255,.92);box-shadow:0 2px 8px rgba(20,23,28,.12);' +
      'cursor:pointer;font-size:17px;line-height:1;color:#8a919b;display:flex;align-items:center;' +
      'justify-content:center;padding:0}' +
      '.ngr-fav:hover{background:#fff;color:#e5342b}' +
      '.ngr-fav.on{color:#e5342b}' +
      '.ngr-pd__fav{margin-top:10px;display:inline-flex;align-items:center;gap:7px;border:1px solid #e3e8ee;' +
      'background:#fff;border-radius:10px;padding:9px 14px;font-size:14px;font-weight:600;' +
      'color:#14171c;cursor:pointer}' +
      '.ngr-pd__fav.on{border-color:#f3b4b0;color:#e5342b;background:#fff6f5}';
    document.head.appendChild(st);
  }

  /** Сердечко на карточке каталога и на карточках полок. */
  function fixFav() {
    favCss();
    document.querySelectorAll('.js-product, .ngr-sc').forEach(function (c) {
      if (c.getAttribute('data-ngr-fav') === '1') return;
      var art = c.classList.contains('ngr-sc') ? c.getAttribute('data-art') : article(c);
      if (!art) return;
      c.setAttribute('data-ngr-fav', '1');
      var host = c.querySelector('.t-catalog__card__imgwrapper, .ngr-sc__pic') || c;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ngr-fav' + (favHas(art) ? ' on' : '');
      b.setAttribute('aria-label', 'В избранное');
      b.textContent = favHas(art) ? '♥' : '♡';
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var on = favToggle(art);
        b.className = 'ngr-fav' + (on ? ' on' : '');
        b.textContent = on ? '♥' : '♡';
      });
      host.appendChild(b);
    });
  }
  function favToggle(a) {
    var l = favList(), i = l.indexOf(String(a));
    if (i > -1) l.splice(i, 1); else l.push(String(a));
    try { localStorage.setItem('ngr_fav', JSON.stringify(l)); } catch (e) {}
    return favHas(a);
  }

  /* ---------- Полки на главной ---------- */

  /**
   * Две подборки: «Чаще всего берут» — по числу отзывов покупателей, и
   * «Скидки недели» — по размеру скидки (решения Александра 07–08.08).
   * Раньше в полке скидок лежал зашитый список из четырёх товаров; теперь
   * обе собираются из всего каталога и только из того, что в наличии.
   */
  var shelves = null;

  fetch(API + '/catalog/shelves')
    .then(function (r) { return r.json(); })
    .then(function (j) { if (j && j.updated) { shelves = j; apply(); } })
    .catch(function () {});

  function shelfCss() {
    if (document.getElementById('ngr-shelf-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-shelf-css';
    st.textContent =
      // justify-items у чужого контейнера прижимал карточки к содержимому —
      // полка выглядела сплющенной в узкие столбики (Александр, 08.08).
      '.ngr-shelf{display:grid!important;grid-template-columns:repeat(4,1fr)!important;' +
      'gap:18px!important;align-items:stretch!important;justify-items:stretch!important}' +
      '.ngr-shelf > .ngr-sc{width:100%!important;max-width:none!important;min-width:0!important}' +
      '.ngr-sc{display:flex;flex-direction:column;background:#fff;border:1px solid #eceff3;' +
      'border-radius:16px;overflow:hidden;text-decoration:none;color:inherit;transition:box-shadow .2s,transform .2s}' +
      '.ngr-sc:hover{box-shadow:0 12px 30px rgba(20,23,28,.10);transform:translateY(-2px)}' +
      '.ngr-sc__pic{position:relative;aspect-ratio:1/1;background:#f7f9fb center/contain no-repeat}' +
      '.ngr-sc__off{position:absolute;top:10px;left:10px;background:#e5342b;color:#fff;font-size:12px;' +
      'font-weight:800;padding:4px 8px;border-radius:8px}' +
      '.ngr-sc__b{padding:14px;display:flex;flex-direction:column;gap:7px;flex:1}' +
      '.ngr-sc__t{font-size:13.5px;line-height:1.4;color:#14171c;display:-webkit-box;' +
      '-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}' +
      '.ngr-sc__r{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#8a919b}' +
      '.ngr-sc__r b{color:#14171c}' +
      '.ngr-sc__p{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:4px}' +
      '.ngr-sc__now{background:#4984c4;color:#fff;font-size:18px;font-weight:800;padding:5px 11px;border-radius:10px}' +
      '.ngr-sc__old{color:#a6adb6;font-size:14px;font-weight:600;text-decoration:line-through}' +
      '@media(max-width:1024px){.ngr-shelf{grid-template-columns:repeat(3,1fr)}}' +
      '@media(max-width:760px){.ngr-shelf{grid-template-columns:repeat(2,1fr);gap:12px}' +
      '.ngr-sc__b{padding:11px;gap:6px}.ngr-sc__t{font-size:13px}' +
      '.ngr-sc__now{font-size:16px;padding:4px 9px}}';
    document.head.appendChild(st);
  }

  function money(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }

  /**
   * Клик по карточке полки.
   *
   * Прямая ссылка на страницу товара не годится: страницы /tproduct/ у нас
   * перенаправляют в каталог, и покупатель улетал непонятно куда (замечание
   * Александра 08.08). Поэтому открываем товар там же, где он живёт, —
   * подставляем его артикул в поиск каталога и прокручиваем к нему.
   */
  /**
   * Клик по карточке полки.
   *
   * Прямая ссылка не годится: страницы /tproduct/ у нас перенаправляют
   * в каталог. Поиск тоже не подошёл — Tilda ищет по названию, а память
   * поиска возвращала прежний запрос, и покупателя просто выбрасывало
   * наверх страницы (замечание Александра 08.08).
   *
   * Открываем ту же всплывающую карточку, что и каталог: находим товар
   * среди карточек каталога по артикулу и нажимаем на него. Если товар
   * не отрисован (каталог грузится частями) — подгружаем, пока не найдём.
   */
  /** Клик по карточке полки открывает наше окно товара. */
  function openFromShelf(art) { openProduct(art); }

  function shelfCard(c) {
    var a = document.createElement('a');
    a.className = 'ngr-sc';
    a.setAttribute('data-art', c.art);
    a.href = c.url || '#';
    a.addEventListener('click', function (e) {
      e.preventDefault();
      openFromShelf(c.art);
    });
    a.innerHTML =
      '<div class="ngr-sc__pic" style="background-image:url(\'' + c.img + '\')">' +
      (c.off ? '<span class="ngr-sc__off">−' + c.off + '%</span>' : '') + '</div>' +
      '<div class="ngr-sc__b">' +
      '<div class="ngr-sc__t"></div>' +
      (c.n ? '<div class="ngr-sc__r">' + stars(c.avg) + '<b>' + c.avg.toFixed(1) + '</b>' +
        '<span>' + c.n + ' ' + plural(c.n, 'отзыв', 'отзыва', 'отзывов') + '</span></div>' : '') +
      '<div class="ngr-sc__p"><span class="ngr-sc__now">' + money(c.price) + '</span>' +
      (c.old ? '<span class="ngr-sc__old">' + money(c.old) + '</span>' : '') +
      (c.off ? '<span class="ngr-off">−' + c.off + '%</span>' : '') + '</div></div>';
    a.querySelector('.ngr-sc__t').textContent = c.title;
    return a;
  }

  /**
   * Карточки кладём прямо в контейнер, без своей обёртки: у полки скидок
   * контейнер сам является сеткой, и вложенная сетка схлопывалась в одну
   * колонку — полка выглядела сплющенной (замечание Александра 08.08).
   */
  function buildShelf(host, list) {
    host.innerHTML = '';
    host.classList.add('ngr-shelf');
    list.forEach(function (c) { host.appendChild(shelfCard(c)); });
  }

  function fixShelves() {
    if (!shelves) return;
    reviewCss(); shelfCss();

    // «Скидки недели» — меняем содержимое существующей полки.
    var sale = document.querySelector('.ngr-sale-grid');
    if (!sale) {
      var anySale = document.querySelector('.ngr-sale-card');
      sale = anySale ? anySale.parentNode : null;
    }
    // Скрипт главной перерисовывает полку после нас и возвращает свои
    // четыре зашитых товара. Поэтому проверяем не пометку на контейнере,
    // а наличие нашей сетки внутри — и перестраиваем, когда её снесли.
    if (sale && shelves.byDiscount.length && !sale.querySelector('.ngr-sc')) {
      sale.setAttribute('data-ngr-shelf', 'sale');
      buildShelf(sale, shelves.byDiscount);
    }

    // «Чаще всего берут» — новая полка перед полкой скидок.
    if (!document.querySelector('.ngr-shelf-top') && shelves.byReviews.length && sale) {
      var sec = sale.closest('section') || sale.parentNode;
      var wrap = document.createElement('section');
      wrap.className = 'ngr-section ngr-shelf-top';
      wrap.style.cssText = 'padding:48px 0';
      var inner = document.createElement('div');
      inner.className = 'ngr-container';
      inner.innerHTML = '<p style="margin:0 0 6px;font-size:12px;letter-spacing:.12em;' +
        'text-transform:uppercase;color:#4984c4;font-weight:700">Выбор покупателей</p>' +
        '<h2 style="margin:0 0 8px;font-size:34px;font-weight:800;letter-spacing:-1px;color:#14171c">Чаще всего берут</h2>' +
        '<p style="margin:0 0 22px;color:#6b7280;font-size:15px">Товары с наибольшим числом отзывов на Ozon — ' +
        'по ним видно, что покупают и как оценивают.</p>';
      var grid = document.createElement('div');
      inner.appendChild(grid);
      wrap.appendChild(inner);
      if (sec && sec.parentNode) sec.parentNode.insertBefore(wrap, sec);
      buildShelf(grid, shelves.byReviews);
    }
  }

  /* ---------- Фильтры каталога ---------- */

  /**
   * «Страна-изготовитель: Россия» — у 18 товаров, но российского товара
   * в ассортименте нет: это ошибка в данных карточек (Александр, 07.08).
   * Пока данные не поправлены, убираем вариант из фильтра, чтобы покупатель
   * не выбирал заведомо неверную подборку.
   */
  var HIDE_FILTER_VALUES = ['Россия'];

  function fixFilterValues() {
    document.querySelectorAll('.t-catalog__filter__item-controls-wrap label, ' +
      '.t-catalog__filter__item-controls-container label').forEach(function (l) {
      if (l.getAttribute('data-ngr-hid')) return;
      var t = (l.textContent || '').trim();
      if (HIDE_FILTER_VALUES.indexOf(t) === -1) return;
      l.setAttribute('data-ngr-hid', '1');
      l.style.setProperty('display', 'none', 'important');
    });
  }

  /**
   * Фильтр по оценке. У Tilda его нет — оценки приходят от нас, поэтому
   * и фильтр наш: добавляем кнопку в общий ряд и прячем карточки с оценкой
   * ниже выбранной (запрос Александра 07.08).
   */
  var minRating = 0;

  function ratingCss() {
    if (document.getElementById('ngr-rf-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-rf-css';
    st.textContent =
      '.ngr-rf{position:relative}' +
      '.ngr-rf__list{position:absolute;top:100%;left:0;z-index:1001;min-width:190px;margin-top:6px;' +
      'background:#fff;border:1px solid #e3e8ee;border-radius:12px;box-shadow:0 10px 30px rgba(20,23,28,.12);' +
      'padding:6px;display:none}' +
      '.ngr-rf_open .ngr-rf__list{display:block}' +
      '.ngr-rf__list b{display:block;padding:9px 12px;border-radius:8px;font-size:14px;font-weight:500;' +
      'color:#14171c;cursor:pointer;white-space:nowrap}' +
      '.ngr-rf__list b:hover{background:#f5f7fa}' +
      '.ngr-rf__list b.on{background:#fff3e8;color:#c2560a;font-weight:700}';
    document.head.appendChild(st);
  }

  var lastRating = null;

  function applyRatingFilter(force) {
    if (!rating || !skuOf) return;
    // Раньше это выполнялось на каждое изменение страницы и трогало стили всех
    // карточек. Tilda видела правку сетки и закрывала открытый список фильтра
    // через секунду после нажатия (замечание Александра 07.08). Теперь
    // работаем, только когда выбор действительно изменился.
    if (!force && lastRating === minRating) return;
    lastRating = minRating;
    document.querySelectorAll('.js-product').forEach(function (c) {
      var a = article(c);
      var r = rating[skuOf[a]];
      var v = r ? r[1] / 10 : 0;
      var hide = minRating > 0 && v < minRating;
      if (hide) {
        c.setAttribute('data-ngr-rate-hidden', '1');
        c.style.setProperty('display', 'none', 'important');
      } else if (c.getAttribute('data-ngr-rate-hidden') === '1') {
        c.removeAttribute('data-ngr-rate-hidden');
        // Не воскрешаем то, что скрыто по остатку.
        if (c.getAttribute('data-ngr-hidden') !== '1') c.style.removeProperty('display');
      }
    });
  }

  function fixRatingFilter() {
    var bar = document.querySelector('.t-catalog__filter__options');
    if (!bar || bar.querySelector('.ngr-rf')) return;
    if (!rating || !skuOf) return;
    // Пока покупатель держит открытым чужой список — не трогаем панель,
    // иначе Tilda пересоберёт её и список схлопнется.
    if (bar.querySelector('.t-catalog__filter__item.active, .t-catalog__filter__item_opened')) return;
    ratingCss();
    var sample = bar.querySelector('.t-catalog__filter__item');
    if (!sample) return;
    var box = sample.cloneNode(true);
    box.className = sample.className + ' ngr-rf';
    box.removeAttribute('data-ngr-price');
    var title = box.querySelector('.t-catalog__filter__item-title');
    var drop = box.querySelector('.t-catalog__filter__item-controls-wrap');
    if (!title || !drop) return;
    title.textContent = 'Оценка';
    drop.parentNode.removeChild(drop);

    var list = document.createElement('div');
    list.className = 'ngr-rf__list';
    var opts = [[0, 'Любая'], [4, 'от 4,0'], [4.5, 'от 4,5'], [4.8, 'от 4,8']];
    list.innerHTML = opts.map(function (o) {
      return '<b data-v="' + o[0] + '"' + (o[0] === minRating ? ' class="on"' : '') + '>' + o[1] + '</b>';
    }).join('');
    box.appendChild(list);

    title.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      box.classList.toggle('ngr-rf_open');
    });
    list.querySelectorAll('b').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        minRating = Number(b.getAttribute('data-v')) || 0;
        list.querySelectorAll('b').forEach(function (x) { x.className = ''; });
        b.className = 'on';
        title.textContent = minRating ? 'Оценка: ' + String(minRating).replace('.', ',') + '+' : 'Оценка';
        box.classList.remove('ngr-rf_open');
        applyRatingFilter();
      });
    });
    document.addEventListener('click', function () { box.classList.remove('ngr-rf_open'); });
    bar.appendChild(box);
  }

  /* ---------- Цена ---------- */

  /**
   * Цена со скидкой должна читаться первой (решение Александра 07.08,
   * образец — карточка Ozon): она на цветной плашке, старая цена рядом
   * зачёркнута и приглушена, справа — процент выгоды. В раскрытой карточке
   * весь блок обведён рамкой, как на Ozon.
   */
  function priceCss() {
    if (document.getElementById('ngr-price-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-price-css';
    st.textContent =
      // Плашка с ценой. В каталоге и в раскрытой карточке у Tilda разные
      // классы (card__price и prod-popup__price) — перечисляем оба, иначе
      // в карточке товара оформление не применяется.
      '.ngr-price .js-catalog-prod-price,.ngr-price .t-catalog__card__price:not(.t-catalog__card__price_old),' +
      '.ngr-price .t-catalog__prod-popup__price:not(.t-catalog__prod-popup__price_old){' +
      'display:inline-flex!important;align-items:center;gap:2px;background:#4984c4!important;' +
      'color:#fff!important;padding:6px 12px!important;border-radius:10px!important;' +
      'font-size:24px!important;font-weight:800!important;line-height:1.15!important;' +
      'letter-spacing:-.5px;width:auto!important}' +
      '.ngr-price .js-catalog-prod-price *,.ngr-price .t-catalog__card__price:not(.t-catalog__card__price_old) *,' +
      '.ngr-price .t-catalog__prod-popup__price:not(.t-catalog__prod-popup__price_old) *{color:#fff!important}' +
      // Старая цена
      // visibility:hidden ставит сама Tilda: текст старой цены в вёрстке есть,
      // но не показывается — от неё оставалась одна чёрточка (Александр, 07.08).
      '.ngr-price .js-catalog-prod-price-old,.ngr-price .t-catalog__card__price_old,' +
      '.ngr-price .t-catalog__prod-popup__price_old{color:#a6adb6!important;font-size:15px!important;' +
      'font-weight:600!important;text-decoration:line-through!important;background:none!important;' +
      'padding:0!important;visibility:visible!important}' +
      '.ngr-price .js-catalog-prod-price-old *,.ngr-price .t-catalog__card__price_old *,' +
      '.ngr-price .t-catalog__prod-popup__price_old *{color:#a6adb6!important}' +
      // Процент выгоды
      '.ngr-off{display:inline-block;background:#eaf7ef;color:#1a8f4c;font-size:12px;font-weight:800;' +
      'padding:4px 8px;border-radius:8px;white-space:nowrap}' +
      '.ngr-price{display:flex!important;align-items:center!important;gap:9px!important;' +
      'flex-wrap:wrap!important;justify-content:flex-start!important;margin:8px 0}' +
      '.ngr-price > *{margin:0!important}' +
      // В раскрытой карточке — рамка вокруг цены, как на Ozon
      '.t-catalog__prod-popup__container .ngr-price{border:1px solid #e8ecf1;border-radius:16px;' +
      'padding:14px 16px;background:#fff;margin:12px 0}' +
      // Полка «Скидки недели» на главной собрана отдельной вёрсткой —
      // приводим её цену к тому же виду, что в каталоге (Александр, 07.08).
      '.ngr-sale-card__bottom strong{display:inline-flex!important;align-items:center;' +
      'background:#4984c4!important;color:#fff!important;padding:6px 12px!important;' +
      'border-radius:10px!important;font-size:21px!important;font-weight:800!important;' +
      'line-height:1.15!important;letter-spacing:-.5px}' +
      '.ngr-sale-card__bottom del{color:#a6adb6!important;font-size:14px!important;' +
      'font-weight:600!important;margin-top:6px;display:inline-block}' +
      '.ngr-sale-card__bottom > div{display:flex;flex-direction:column;align-items:flex-start;gap:2px}' +
      '@media(max-width:640px){' +
      '.ngr-price .t-catalog__card__price:not(.t-catalog__card__price_old){font-size:21px!important;padding:5px 10px}' +
      '.ngr-sale-card__bottom strong{font-size:19px!important;padding:5px 10px!important}' +
      '.ngr-price{gap:8px}}';
    document.head.appendChild(st);
  }

  function num(el) {
    return Number(String((el && el.textContent) || '').replace(/[^\d]/g, '')) || 0;
  }

  function fixPrices() {
    priceCss();
    var hosts = document.querySelectorAll('.js-catalog-price-wrapper, .t-catalog__card__price-wrapper, ' +
      '.t-catalog__prod-popup__price-wrapper');
    hosts.forEach(function (w) {
      var now = w.querySelector('.js-catalog-prod-price, .t-catalog__card__price:not(.t-catalog__card__price_old), ' +
        '.t-catalog__prod-popup__price:not(.t-catalog__prod-popup__price_old)');
      var old = w.querySelector('.js-catalog-prod-price-old, .t-catalog__card__price_old, ' +
        '.t-catalog__prod-popup__price_old');
      if (!now) return;
      var a = num(now), b = num(old);
      // В раскрытой карточке Tilda подставляет цены не сразу. Раньше мы
      // считали один раз и на пустом месте — старая цена оставалась пустой
      // строкой, а процент не появлялся (замечание Александра 07.08).
      // Поэтому запоминаем прочитанную пару и пересчитываем, когда изменится.
      // Пометку ставим на саму цену, а не на обёртку. Tilda пересобирает
      // внутренности карточки: обёртка со старой пометкой остаётся, а элементы
      // цены заменяются новыми — и оформление пропадало, хотя код считал,
      // что уже всё сделал (замечание Александра 07.08).
      var sig = 'v3:' + a + '/' + b;
      if (now.getAttribute('data-ngr-styled') === sig) return;
      now.setAttribute('data-ngr-styled', sig);
      w.classList.add('ngr-price');
      // Звёзды не должны стоять в строке с ценой — им место над ней.
      var rate = w.querySelector('.ngr-rate');
      if (rate && w.parentNode) w.parentNode.insertBefore(rate, w);

      var off = w.querySelector('.ngr-off');
      if (b > a && a > 0) {
        if (!off) {
          off = document.createElement('span');
          off.className = 'ngr-off';
          w.appendChild(off);
        }
        off.textContent = '−' + Math.round((b - a) / b * 100) + '%';
      } else if (off) {
        off.parentNode.removeChild(off);
      }
      // Стили ставим прямо на элемент. Через таблицу стилей не получалось:
      // в каталоге правило перебивалось собственными стилями Tilda, а старой
      // цене она вдобавок ставит visibility:hidden — текст есть, но не виден.
      now.style.setProperty('display', 'inline-flex', 'important');
      now.style.setProperty('align-items', 'center', 'important');
      now.style.setProperty('background', '#4984c4', 'important');
      now.style.setProperty('color', '#fff', 'important');
      now.style.setProperty('padding', '6px 12px', 'important');
      now.style.setProperty('border-radius', '10px', 'important');
      now.style.setProperty('line-height', '1.15', 'important');
      now.style.setProperty('width', 'auto', 'important');
      [].forEach.call(now.querySelectorAll('*'), function (e) {
        e.style.setProperty('color', '#fff', 'important');
      });
      // Свою зачёркнутую цену рисуем сами. Элемент Tilda для неё есть, текст
      // в нём тоже есть, но она держит его скрытым, и снять это снаружи
      // не удаётся — цена оставалась чёрточкой (Александр, 07.08).
      // Чужой элемент убираем совсем: он скрыт, но продолжал занимать место —
      // между ценой и скидкой зиял провал, а процент срывался на вторую
      // строку (Александр, 08.08).
      if (old) old.style.setProperty('display', 'none', 'important');
      var mine = w.querySelector('.ngr-oldprice');
      if (b > a && a > 0) {
        if (!mine) {
          mine = document.createElement('span');
          mine.className = 'ngr-oldprice';
          mine.style.cssText = 'color:#a6adb6;font-size:15px;font-weight:600;' +
            'text-decoration:line-through;white-space:nowrap';
          if (off && off.parentNode === w) w.insertBefore(mine, off);
          else w.appendChild(mine);
        }
        mine.textContent = String(b).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' р.';
      } else if (mine) {
        mine.parentNode.removeChild(mine);
      }
    });
  }

  /* ---------- Фото в карточке каталога ---------- */

  /**
   * При наведении на карточку Tilda подменяет фото вторым — и покупатель
   * видел серый прямоугольник (замечание Александра 07.08). Причина: второй
   * слой показывается сразу, а картинка в нём к этому моменту ещё не
   * загружена, а иногда не открывается вовсе.
   *
   * Чиним так: заранее проверяем второе фото. Загрузилось — включаем
   * листание точками, как на маркетплейсах. Не загрузилось — прячем слой,
   * и при наведении остаётся основное фото вместо серой заливки.
   */
  function galleryCss() {
    if (document.getElementById('ngr-gal-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-gal-css';
    st.textContent =
      '.ngr-gal{position:absolute;left:0;right:0;bottom:8px;display:flex;gap:5px;' +
      'justify-content:center;z-index:3;pointer-events:auto}' +
      '.ngr-gal b{width:22px;height:4px;border-radius:3px;background:rgba(20,23,28,.22);cursor:pointer;transition:background .15s}' +
      '.ngr-gal b.on{background:#ff7a1a}' +
      '.ngr-gal b:hover{background:rgba(20,23,28,.45)}' +
      '@media(max-width:640px){.ngr-gal b{width:26px;height:5px}}';
    document.head.appendChild(st);
  }

  var photoCache = {};

  /**
   * Галерея как на маркетплейсах: все фото товара, точки под снимком,
   * переключение наведением. Подмену вторым фото от Tilda выключаем совсем —
   * именно она давала серый экран (замечание Александра 07.08). Фото берём
   * из Ozon через интегратор, для открытого товара и один раз.
   */
  function buildGallery(card, photos) {
    var layers = [].slice.call(card.querySelectorAll('.t-catalog__card__bgimg'));
    if (!layers.length || !photos.length) return false;
    // Фото Tilda уже загружено и лежит в кеше браузера, а снимки Ozon весят
    // по мегабайту и приезжают не сразу. Раньше я подменял картинку сразу —
    // и карточка стояла пустой, пока фото едет (замечание Александра 08.08).
    // Теперь снимок Tilda остаётся первым кадром, Ozon идёт следом.
    var orig = getComputedStyle(layers[0]).backgroundImage;
    // Пока фото не загрузилось, Tilda рисует цветную заглушку — это не 'none',
    // а градиент. Раньше он попадал в галерею первым кадром, и карточка
    // навсегда оставалась размытым пятном (замечание Александра 08.08).
    if (!orig || orig.indexOf('url(') !== 0) return false;
    var slides = [orig];
    photos.forEach(function (u) {
      var s = 'url("' + u + '")';
      if (slides.indexOf(s) === -1) slides.push(s);
    });
    if (slides.length < 2) return true;
    // Слои не прячем. У разных карточек видимым оказывается то первый, то
    // второй — пряча «лишний», я гасил у части товаров само фото
    // (замечание Александра 08.08). Вместо этого следим, чтобы картинка
    // была у каждого слоя, и переключаем их все разом.
    galleryCss();
    var wrap = layers[0].parentNode;
    if (!wrap || wrap.querySelector('.ngr-gal')) return true;
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    var gal = document.createElement('div');
    gal.className = 'ngr-gal';
    gal.innerHTML = slides.map(function (_, i) { return '<b' + (i ? '' : ' class="on"') + '></b>'; }).join('');
    var dots = [].slice.call(gal.querySelectorAll('b'));
    var loaded = false;
    function preload() {
      if (loaded) return;
      loaded = true;
      slides.slice(1).forEach(function (s) {
        var im = new Image();
        im.src = s.replace(/^url\(\"?|\"?\)$/g, '');
      });
    }
    function show(i) {
      layers.forEach(function (l) { l.style.setProperty('background-image', slides[i], 'important'); });
      dots.forEach(function (d, k) { d.className = k === i ? 'on' : ''; });
    }
    dots.forEach(function (d, i) {
      d.addEventListener('mouseenter', function () { show(i); });
      d.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); show(i); });
    });
    // Остальные снимки тянем только когда покупатель навёл на карточку —
    // иначе главная тащит десятки мегабайт впустую.
    wrap.addEventListener('mouseenter', preload);
    wrap.addEventListener('mouseleave', function () { show(0); });
    wrap.appendChild(gal);
    return true;
  }

  function fixCardPhotos() {
    document.querySelectorAll('.js-product').forEach(function (c) {
      if (c.getAttribute('data-ngr-gal')) return;
      var layers = c.querySelectorAll('.t-catalog__card__bgimg');
      if (!layers.length) return;
      var a = article(c);
      if (!a) return;
      c.setAttribute('data-ngr-gal', 'wait');
      // Пометку ставим только когда галерея действительно собрана: пока фото
      // Tilda не загружено, собирать нечего — вернёмся на следующем проходе.
      if (photoCache[a]) {
        if (buildGallery(c, photoCache[a])) c.setAttribute('data-ngr-gal', '1');
        else c.removeAttribute('data-ngr-gal');
        return;
      }
      fetch(API + '/catalog/photos?offer=' + encodeURIComponent(a))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          photoCache[a] = (j && j.photos) || [];
          if (buildGallery(c, photoCache[a])) c.setAttribute('data-ngr-gal', '1');
          else c.removeAttribute('data-ngr-gal');
        })
        .catch(function () { c.setAttribute('data-ngr-gal', '1'); });
    });
  }

  /* ---------- Описание товара ---------- */

  /**
   * В карточке описание шло сплошной портянкой: несколько экранов текста,
   * а под ним списком характеристики. Читать невозможно (замечание
   * Александра 07.08). Разбираем на два раскрывающихся блока, как на Ozon:
   * «Описание» и «Характеристики» таблицей.
   *
   * Исходный текст не выбрасываем — прячем рядом, чтобы ничего не потерять.
   */
  function descCss() {
    if (document.getElementById('ngr-desc-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-desc-css';
    st.textContent =
      '.ngr-acc{border:1px solid #e8ecf1;border-radius:16px;background:#fff;margin:14px 0;overflow:hidden}' +
      '.ngr-acc__head{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
      'padding:16px 18px;cursor:pointer;user-select:none;font-size:16px;font-weight:700;color:#14171c}' +
      '.ngr-acc__head:hover{background:#fafbfc}' +
      '.ngr-acc__sign{flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:#f3f5f8;' +
      'display:flex;align-items:center;justify-content:center;font-size:13px;color:#6b7280;transition:transform .2s}' +
      '.ngr-acc_open .ngr-acc__sign{transform:rotate(180deg)}' +
      '.ngr-acc__body{display:none;padding:0 18px 18px;font-size:14.5px;line-height:1.65;color:#2b2f36}' +
      '.ngr-acc_open .ngr-acc__body{display:block}' +
      '.ngr-acc__body p{margin:0 0 10px;color:#2b2f36}' +
      '.ngr-spec{width:100%;border-collapse:collapse}' +
      '.ngr-spec tr{border-top:1px solid #f0f2f5}' +
      '.ngr-spec tr:first-child{border-top:0}' +
      '.ngr-spec td{padding:9px 0;font-size:14px;vertical-align:top}' +
      '.ngr-spec td:first-child{color:#8a919b;width:46%;padding-right:14px}' +
      '.ngr-spec td:last-child{color:#14171c}' +
      '@media(max-width:640px){' +
      '.ngr-acc__head{padding:14px;font-size:15px}' +
      '.ngr-acc__body{padding:0 14px 14px;font-size:14px}' +
      '.ngr-spec td{font-size:13.5px}' +
      '.ngr-spec td:first-child{width:42%}}';
    document.head.appendChild(st);
  }

  function accordion(title, openByDefault) {
    var a = document.createElement('div');
    a.className = 'ngr-acc' + (openByDefault ? ' ngr-acc_open' : '');
    a.innerHTML = '<div class="ngr-acc__head">' + title +
      '<span class="ngr-acc__sign">▾</span></div><div class="ngr-acc__body"></div>';
    a.querySelector('.ngr-acc__head').addEventListener('click', function () {
      a.classList.toggle('ngr-acc_open');
    });
    return a;
  }

  function fixDescription() {
    var pop = document.querySelector('.t-popup_show .t-catalog__prod-popup__container, ' +
      '.t-catalog__prod-popup__container');
    if (!pop || !pop.getBoundingClientRect().width) return;
    var el = pop.querySelector('.js-catalog-prod-text, .t-catalog__prod-popup__text');
    if (!el || el.getAttribute('data-ngr-desc') === '1') return;
    var raw = (el.innerText || '').replace(/ /g, ' ').trim();
    if (raw.length < 60) return;
    el.setAttribute('data-ngr-desc', '1');
    descCss();

    // Характеристики — строки вида «Название: значение» в конце текста.
    var lines = raw.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var specs = [];
    while (lines.length) {
      var last = lines[lines.length - 1];
      var m = last.match(/^([^:]{2,45}):\s*(.+)$/);
      if (!m || m[1].split(' ').length > 6) break;
      specs.unshift([m[1], m[2]]);
      lines.pop();
    }
    var body = lines.join('\n\n');
    if (!specs.length && body.length < 400) { el.removeAttribute('data-ngr-desc'); return; }

    var wrap = document.createElement('div');
    wrap.className = 'ngr-descwrap';

    if (body) {
      var a1 = accordion('Описание', false);
      var b1 = a1.querySelector('.ngr-acc__body');
      body.split('\n\n').forEach(function (p) {
        var el2 = document.createElement('p');
        el2.textContent = p;          // текст, а не разметка
        b1.appendChild(el2);
      });
      wrap.appendChild(a1);
    }
    if (specs.length) {
      var a2 = accordion('Характеристики', true);
      var tb = document.createElement('table');
      tb.className = 'ngr-spec';
      specs.forEach(function (s) {
        var tr = document.createElement('tr');
        var td1 = document.createElement('td'); td1.textContent = s[0];
        var td2 = document.createElement('td'); td2.textContent = s[1];
        tr.appendChild(td1); tr.appendChild(td2); tb.appendChild(tr);
      });
      a2.querySelector('.ngr-acc__body').appendChild(tb);
      wrap.appendChild(a2);
    }

    el.style.display = 'none';        // исходный текст прячем, но оставляем
    el.parentNode.insertBefore(wrap, el);
  }

  /**
   * Сроки доставки — выше описания и характеристик (решение Александра 07.08):
   * покупателю сначала важно, когда он получит товар, а уже потом состав.
   * Виджет доставки рисуется отдельно и может появиться позже наших блоков,
   * поэтому положение поправляем каждый раз, а не один раз при сборке.
   */
  function fixDeliveryOrder() {
    var pop = document.querySelector('.t-popup_show .t-catalog__prod-popup__container, ' +
      '.t-catalog__prod-popup__container');
    if (!pop) return;
    var wrap = pop.querySelector('.ngr-descwrap');
    var del = pop.querySelector('.nutrygo-delivery');
    if (!wrap || !del) return;
    if (del.nextElementSibling === wrap) return;   // уже стоит выше
    wrap.parentNode.insertBefore(del, wrap);
  }

  var FIRST_SHOWN = 3;   // остальные — по кнопке, чтобы карточка не растягивалась

  function renderReviews(box, sku, data) {
    var n = data.n || 0;
    if (!n) { box.innerHTML = ''; return; }
    var list = data.list || [];
    var dist = [0, 0, 0, 0, 0];
    list.forEach(function (r) { if (r.r >= 1 && r.r <= 5) dist[r.r - 1]++; });
    var shown = list.length;

    var bars = '';
    for (var s = 5; s >= 1; s--) {
      var cnt = dist[s - 1];
      var part = shown ? Math.round(cnt / shown * 100) : 0;
      bars += '<div class="ngr-revbar"><u>' + s + ' ★</u><i><s style="width:' + part + '%"></s></i>' +
        '<em>' + (cnt || '') + '</em></div>';
    }

    var items = list.map(function (r, i) {
      var pics = (r.ph || []).map(function (u) {
        return '<a href="' + u + '" target="_blank" rel="noopener"><img src="' + u + '" alt="Фото покупателя" loading="lazy"></a>';
      }).join('');
      return '<div class="ngr-rev"' + (i >= FIRST_SHOWN ? ' data-extra="1" style="display:none"' : '') + '>' +
        '<div class="ngr-rev__ava">👤</div>' +
        '<div class="ngr-rev__body">' +
        '<div class="ngr-rev__top"><span class="ngr-rev__who">Покупатель Ozon</span>' +
        (r.v ? '<span class="ngr-rev__ok">✓ Проверенная покупка</span>' : '') +
        '<span class="ngr-rev__date">' + (r.d || '').split('-').reverse().join('.') + '</span></div>' +
        '<div>' + stars(r.r) + '</div>' +
        '<div class="ngr-rev__text"></div>' +
        (pics ? '<div class="ngr-rev__pics">' + pics + '</div>' : '') +
        '</div></div>';
    }).join('');

    var hidden = Math.max(0, shown - FIRST_SHOWN);
    box.innerHTML =
      '<h4>Отзывы покупателей</h4>' +
      '<div class="ngr-revhead">' +
      '<div class="ngr-revscore"><div class="ngr-revbig">' + (data.avg || 0).toFixed(1) + '</div>' +
      '<div><div>' + stars(data.avg || 0) + '</div>' +
      '<div class="ngr-revcount">' + n + ' ' + plural(n, 'отзыв', 'отзыва', 'отзывов') + '</div></div></div>' +
      (shown ? '<div class="ngr-revbars">' + bars + '</div>' : '') + '</div>' + items +
      (hidden ? '<button type="button" class="ngr-revmore">Показать ещё ' + hidden + ' ' +
        plural(hidden, 'отзыв', 'отзыва', 'отзывов') + '</button>' : '') +
      (shown ? '' : '<div class="ngr-revnote">Покупатели поставили оценки, но не написали отзыв.</div>') +
      '<div class="ngr-revnote">Оценки и отзывы оставили покупатели Ozon после получения заказа. ' +
      'Мы показываем их как есть и ничего не удаляем.</div>';

    // Текст отзыва вставляем как текст, а не разметку: его пишут покупатели.
    var nodes = box.querySelectorAll('.ngr-rev__text');
    list.forEach(function (r, i) { if (nodes[i]) nodes[i].textContent = r.x || ''; });

    var more = box.querySelector('.ngr-revmore');
    if (more) more.addEventListener('click', function () {
      // Кнопка переключает, а не исчезает: развернув список, покупатель
      // должен иметь возможность его свернуть (замечание Александра 07.08).
      var open = more.getAttribute('data-open') === '1';
      box.querySelectorAll('[data-extra]').forEach(function (e) { e.style.display = open ? 'none' : ''; });
      more.setAttribute('data-open', open ? '0' : '1');
      more.textContent = open
        ? 'Показать ещё ' + hidden + ' ' + plural(hidden, 'отзыв', 'отзыва', 'отзывов')
        : 'Свернуть отзывы';
      if (open) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  /** Развёрнутая карточка товара: сводка, распределение оценок и тексты. */
  function fixPopupReviews() {
    if (!rating || !skuOf) return;
    var pop = document.querySelector('.t-popup_show .t-catalog__prod-popup__container, ' +
      '.t-catalog__prod-popup__container, .t-store__prod-popup__container');
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
      // Ставим отзывы ПЕРЕД описанием, а не в самый низ: описание у нас
      // длинное, и до отзывов внизу покупатель просто не доходил
      // (замечание Александра 07.08).
      var desc = pop.querySelector('.js-catalog-prod-text, .t-catalog__prod-popup__text, .t-store__prod-popup__text');
      var host = pop.querySelector('.t-catalog__prod-popup__info, .t-store__prod-popup__info') || pop;
      if (desc && desc.parentNode) desc.parentNode.insertBefore(box, desc);
      else host.appendChild(box);
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
    fixRatings(); fixPopupReviews(); fixDescription(); fixDeliveryOrder(); fixCardPhotos(); fixPrices(); fixFilterValues(); fixRatingFilter(); applyRatingFilter(false); fixShelves(); fixSgr(); fixFav();
  }

  apply();
  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', apply);
  new MutationObserver(function () { apply(); })
    .observe(document.documentElement, { childList: true, subtree: true });
})();
