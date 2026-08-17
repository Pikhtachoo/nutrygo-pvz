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

  /**
   * Гасим холостые записи в DOM.
   *
   * Присвоение узлу того значения, которое у него уже стоит, не меняет
   * ничего видимого, но обходится дорого: браузер помечает узел грязным и
   * пересчитывает стиль, а MutationObserver получает запись — и если этот
   * наблюдатель сам же запускает проход, который снова пишет то же самое,
   * получается круг.
   *
   * Замер на живом каталоге 13.08.2026, первые секунды после загрузки, пока
   * догружаются карточки: 5612 мутаций за три секунды, из них
   *   1620  class у .js-product
   *   1332  hidden у .ng2-brand-qty
   *    288  href у ссылок карточек
   * Источник — инлайновые блоки Tilda в записи rec2514481201 (NG2LoadAll2 и
   * BrandCardFix): три записи hidden, две className и пять setAttribute,
   * и ни одной сверки перед записью, всё под двумя MutationObserver.
   * Тех блоков нет в этом репозитории, поэтому чиним со своей стороны.
   *
   * Приём безопасен по смыслу: мы отменяем только записи, которые и так
   * ничего не меняют. Сравнение стоит одну операцию и выполняется до записи,
   * поэтому настоящие изменения проходят как прежде.
   */
  (function () {
    if (window.NGR_NOOP_GUARD) return;
    window.NGR_NOOP_GUARD = 1;
    // Сравнивать class как строку мало. Замер 13.08 показал: из 160
    // прослеженных переходов класса карточки все 160 — тот же самый набор
    // классов, записанный другой строкой (иной порядок или лишние пробелы).
    // Для отбора правил важен только набор, поэтому сверяем набор.
    var норма = function (s) {
      return String(s == null ? '' : s).split(/\s+/).filter(Boolean).sort().join(' ');
    };
    var тотЖеКласс = function (a, b) {
      return a === b || норма(a) === норма(b);
    };
    try {
      var cn = Object.getOwnPropertyDescriptor(Element.prototype, 'className');
      if (cn && cn.get && cn.set) {
        Object.defineProperty(Element.prototype, 'className', {
          configurable: true, enumerable: cn.enumerable,
          get: function () { return cn.get.call(this); },
          set: function (v) {
            var было = cn.get.call(this);
            // У SVG className — объект, а не строка: такие записи пропускаем
            // дальше без разбора, как было до заслона.
            if (typeof было === 'string' && тотЖеКласс(v, было)) return;
            cn.set.call(this, v);
          }
        });
      }
      var hd = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
      if (hd && hd.get && hd.set) {
        Object.defineProperty(HTMLElement.prototype, 'hidden', {
          configurable: true, enumerable: hd.enumerable,
          get: function () { return hd.get.call(this); },
          // Только чистые true/false: у hidden бывает ещё значение
          // 'until-found', и сводить его к булеву нельзя.
          set: function (v) {
            if ((v === true || v === false) && v === hd.get.call(this)) return;
            hd.set.call(this, v);
          }
        });
      }
      // Только class, href и style: остальные атрибуты трогать незачем, а
      // лишняя сверка на каждом setAttribute — это расход на всём, что
      // рисует Tilda. class сверяем по набору, остальные по строке.
      var sa = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (name === 'class') {
          if (тотЖеКласс(value, this.getAttribute('class'))) return;
        } else if (name === 'href' || name === 'style') {
          if (this.getAttribute(name) === String(value)) return;
        }
        return sa.apply(this, arguments);
      };
    } catch (e) {}
  })();

  /**
   * Пауза автозагрузчика, пока человек работает с поиском или сортировкой.
   *
   * Замечание Александра 13.08: «навожусь на сортировку, выбрать к примеру по
   * цене, и он начинает моргать, то видно список сортировки, то нет; так же с
   * поиском — написал что-то и вижу, как текст то видно, то нет».
   *
   * Замер это подтвердил дословно. За шесть секунд поле поиска пересоздалось
   * семь раз и селект сортировки семь раз: узлы, взятые в начале замера,
   * оказались выброшены из документа (isConnected === false), а набранный
   * текст пропадал вместе с ними — в 22 пробах из 24 поле было пустым.
   * В событиях DOM видно, как Tilda заново строит всю панель фильтров:
   * в js-catalog-filter-tree-container добавляется новый
   * .t-catalog__filter-tree-wrapper, в .t-catalog__filter__options — новый
   * .t-catalog__filter__item_sort-mobile (таких блоков к концу загрузки
   * накапливается девять).
   *
   * Тактирует это автозагрузчик каталога — инлайновый блок NG2LoadAll2 в
   * записи rec2514481201: он раз в 500–600 мс жмёт кнопку «Загрузить ещё»
   * (до 500 раз), Tilda на каждую догрузку перестраивает панель фильтров, а
   * перестроенная панель — это новые input и select. Отсюда и «раз в
   * полсекунды»: открытый список сортировки закрывается, потому что элемента,
   * которому он принадлежал, больше нет.
   *
   * Останавливать загрузку насовсем нельзя — без неё каталог отдаёт горстку
   * товаров. Поэтому загрузку откладываем ровно на то время, пока человек
   * печатает в поиске или выбирает сортировку, а потом продолжаем с того же
   * места. Настоящий щелчок человека по кнопке не трогаем.
   */
  (function () {
    if (window.NGR_LOADER_PAUSE) return;
    window.NGR_LOADER_PAUSE = 1;
    var КНОПКА = '.js-catalog-load-more-btn';
    var отложено = false;

    function человекЗанят() {
      /*
       * Исключение: человек ищет, а искомое ещё не доехало.
       *
       * Поиск по каталогу у Tilda работает по тому, что уже нарисовано на
       * странице: при вводе не уходит ни одного запроса на сервер (замер
       * 17.08). Пока мы держали загрузку, обход не доходил до конца, дорисовка
       * не наступала — и товар с живым остатком не находился. Замечание
       * Александра 17.08: артикул 10754, в наличии 1700 шт., поиск его не
       * видит. Поэтому одну догрузку пропускаем: её ответом витрина
       * дополняется целиком, и находка появляется.
       */
      if (window.NGR_ЕСТЬ_ЧТО_ДОБРАТЬ && ищутВКаталоге()) return false;
      var ae = document.activeElement;
      if (ae && ae.classList &&
          (ae.classList.contains('js-catalog-filter-search') ||
           ae.classList.contains('t-catalog__sort-select'))) return true;
      // Непустое поле поиска — тоже работа: человек читает выдачу по своему
      // запросу, и перестройка панели сотрёт ему текст.
      var inp = document.querySelector('#rec2502703571 .js-catalog-filter-search');
      return !!(inp && inp.value);
    }

    document.addEventListener('click', function (e) {
      // Живой щелчок человека пропускаем всегда: он сам решил догрузить.
      if (e.isTrusted) return;
      var t = e.target;
      if (!t || !t.closest || !t.closest(КНОПКА)) return;
      if (!человекЗанят()) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      отложено = true;
    }, true);

    function продолжить() {
      if (!отложено || человекЗанят()) return;
      var btn = document.querySelector('#rec2502703571 ' + КНОПКА) ||
                document.querySelector(КНОПКА);
      if (!btn) return;
      отложено = false;
      btn.click();
    }
    // Проверяем и по событиям, и раз в секунду: поле могло исчезнуть вместе
    // с панелью, и событие blur тогда не придёт.
    document.addEventListener('blur', продолжить, true);
    document.addEventListener('change', продолжить, true);
    setInterval(продолжить, 1000);
  })();

  var API = 'https://nutrygo-integrator.pikhtovnikov-alieksandr.workers.dev';

  /*
   * Счётчик Яндекс.Метрики.
   *
   * До 17.08 на сайте не было ни одного счётчика: ни Метрики, ни GA, ни VK —
   * проверено по разметке и по сетевым запросам. Магазин работал вслепую:
   * не видно ни откуда приходят покупатели, ни где они уходят.
   *
   * Ставим отсюда, а не в поле Tilda: `custom.css` и блок с защитой промокода
   * уже показали, что живущее только внутри Tilda теряется при пересборке
   * оформления и обнаруживается это не сразу.
   *
   * `ecommerce: dataLayer` — задел на события покупки: складывать их в
   * `dataLayer` можно будет, не трогая счётчик.
   */
  var СЧЁТЧИК_МЕТРИКИ = 111679170;

  (function метрика() {
    if (window.ym) return;
    // В редакторе Tilda и на предпросмотре считать нечего.
    if (/tilda\.(cc|ru)$/i.test(location.hostname)) return;
    // Номер обязателен прямо в ссылке: без него tag.js загружается, но
    // счётчик не поднимается — проверено 17.08, ни хита, ни yaCounter.
    var адрес = 'https://mc.yandex.ru/metrika/tag.js?id=' + СЧЁТЧИК_МЕТРИКИ;
    for (var i = 0; i < document.scripts.length; i++) {
      if (String(document.scripts[i].src).indexOf('mc.yandex.ru/metrika') > -1) return;
    }
    window.ym = window.ym || function () { (window.ym.a = window.ym.a || []).push(arguments); };
    window.ym.l = 1 * new Date();
    var s = document.createElement('script');
    s.async = 1;
    s.src = адрес;
    var первый = document.getElementsByTagName('script')[0];
    первый.parentNode.insertBefore(s, первый);
    window.ym(СЧЁТЧИК_МЕТРИКИ, 'init', {
      ssr: true,
      webvisor: true,
      clickmap: true,
      ecommerce: 'dataLayer',
      accurateTrackBounce: true,
      trackLinks: true
    });
  })();

  /*
   * Промокод не должен стираться из корзины.
   *
   * Перенесено 17.08 из блока Tilda `NGRPromoGuard20260813`, поставленного
   * 13.08. Сам разбор тогда: наш `render() → loadCart() → tcart__loadLocalObj()`
   * срабатывал по наблюдателю сразу после применения промокода и перечитывал
   * корзину из памяти браузера, где промокода ещё нет. Скидка стиралась за
   * миллисекунды: покупатель видел её в итогах, а счёт в Ozon Pay уходил на
   * полную сумму.
   *
   * Почему перенесено: тот блок живёт только внутри Tilda, в исходниках его
   * нет, и любая пересборка оформления молча вернула бы денежный дефект.
   * Метка `NGRPromoGuard20260813` — общая с ним: кто успел первым, тот и
   * ставит защиту, второй ничего не делает. Поэтому блок можно удалить
   * в Tilda в любой момент, разрыва не будет.
   */
  (function защитаПромокода() {
    if (window.NGRPromoGuard20260813) return;
    window.NGRPromoGuard20260813 = 1;
    function поставить() {
      var f = window.tcart__loadLocalObj;
      if (typeof f !== 'function' || f.__ngrGuarded) return false;
      var обёртка = function () {
        var c = window.tcart;
        // Пока промокод применён, перечитывать корзину с диска нельзя.
        if (c && c.promocode) return;
        return f.apply(this, arguments);
      };
      обёртка.__ngrGuarded = 1;
      window.tcart__loadLocalObj = обёртка;
      return true;
    }
    if (поставить()) return;
    // Корзина Tilda подгружается позже — ждём её появления.
    if (typeof window.t_onFuncLoad === 'function') {
      window.t_onFuncLoad('tcart__loadLocalObj', поставить);
      return;
    }
    var попыток = 0;
    var часы = setInterval(function () {
      if (поставить() || ++попыток > 100) clearInterval(часы);
    }, 100);
  })();

  /**
   * Просим у Tilda сразу только то, что есть на складе.
   *
   * Tilda листает и сортирует по всему каталогу, включая товар без остатка,
   * а наш заслон прячет такие карточки уже на странице. При сортировке
   * по убыванию цены она отдавала одиннадцать самых дорогих, из которых
   * в наличии оказывалось четыре — покупатель видел четыре карточки и решал,
   * что каталог кончился (замечание Александра 08.08). Измерено: с этой
   * поправкой на той же сортировке доступных товаров 125 вместо четырёх.
   *
   * Со включённой сортировкой Tilda вдобавок не отдаёт признак следующей
   * страницы, и подгрузка обрывается на первой — поэтому просим страницу
   * побольше.
   */
  /*
   * Все бренды магазина — то самое перечисление, которым запрос уводится
   * на свежий указатель Tilda.
   *
   * Список берём живым из фильтров самой Tilda и держим в памяти браузера.
   * Зашитый перечень устарел бы на первом же новом бренде — именно этого
   * опасались, когда 16.08 перечисление сняли. Пока список не пришёл (самое
   * первое открытие сайта), работает запасной, снятый с Tilda 16.08; к
   * следующему заходу он заменится живым.
   */
  var БРЕНДЫ_КЛЮЧ = 'ngr:brands';
  var БРЕНДЫ_ГОДНОСТЬ = 24 * 60 * 60 * 1000;
  var БРЕНДЫ_ЗАПАС = [
    '21st Century', 'AllNutrition', 'California Gold Nutrition', 'Doctors Best',
    'Life Extension', 'NOW', 'NaturesPlus', 'Nutrex', 'Olimp', 'OstroVit',
    'Promensil', 'SAN', 'SFD Nutrition', 'Sambucol', 'Smartlife', 'Solaray',
    'Swanson', 'Thorne', 'Ultimate Nutrition', 'UltraVit', 'VPLAB'
  ];

  function запросИзБрендов(list) {
    var q = '';
    for (var i = 0; i < list.length; i++) {
      q += (i ? '&' : '') + 'filters%5Bbrand%5D%5B' + i + '%5D=' + encodeURIComponent(list[i]);
    }
    return q;
  }

  var БРЕНДЫ_КОГДА = 0;
  var БРЕНДЫ = (function () {
    try {
      var s = JSON.parse(localStorage.getItem(БРЕНДЫ_КЛЮЧ) || 'null');
      if (s && s.list && s.list.length) { БРЕНДЫ_КОГДА = s.when || 0; return s.list; }
    } catch (e) {}
    return БРЕНДЫ_ЗАПАС;
  })();
  var ЗАПРОС_БРЕНДОВ = запросИзБрендов(БРЕНДЫ);

  // Обновляем список не чаще раза в сутки и всегда исходным fetch: наша же
  // поправка иначе допишет бренды в запрос за списком брендов.
  function обновитьБренды(исходныйFetch) {
    if (Date.now() - БРЕНДЫ_КОГДА < БРЕНДЫ_ГОДНОСТЬ) return;
    var u = 'https://store.tildaapi.com/api/getproductslist/?storepartuid=415554505293' +
            '&recid=2502703571&getallparts=true&size=1&c=' + Date.now();
    исходныйFetch.call(window, u)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var groups = (((j || {}).filters || {}).filters) || [];
        var g = null;
        for (var i = 0; i < groups.length; i++) if (groups[i] && groups[i].name === 'brand') g = groups[i];
        var list = ((g && g.values) || []).map(function (v) { return String((v && v.value) || ''); })
                                          .filter(function (n) { return n; });
        // Куцему ответу не верим: лучше вчерашний список, чем пустой запрос.
        if (list.length < 5) return;
        БРЕНДЫ = list;
        БРЕНДЫ_КОГДА = Date.now();
        ЗАПРОС_БРЕНДОВ = запросИзБрендов(list);
        try {
          localStorage.setItem(БРЕНДЫ_КЛЮЧ, JSON.stringify({ when: БРЕНДЫ_КОГДА, list: list }));
        } catch (e) {}
      })
      .catch(function () {});
  }

  /* ---------- Наши товары внутри ответа Tilda ---------- */

  /*
   * Почему так, а не дорисовкой карточек.
   *
   * Выдача Tilda регулярно оказывается неполной, и до 16.08 это лечили тем,
   * что дорисовывали недостающие карточки своей вёрсткой поверх готовой
   * страницы. Так карточки не совпадали с соседними, а когда их сделали
   * копией настоящей — ряд на главной начал мерцать: Tilda перерисовывает его
   * целиком, наши карточки сносило, витрина возвращала их обратно, и так по
   * кругу (замечание Александра 16.08 со снимком).
   *
   * Правильное место — не после отрисовки, а до неё. Tilda ходит за каталогом
   * одним способом, XHR (проверено замером: 4 запроса XHR, ни одного fetch),
   * и читает ответ как текст. Значит наши товары можно положить прямо в её
   * ответ: дальше она рисует их сама, теми же карточками, с ценой, отметкой
   * СГР, отзывами, «В корзину» и «Подробнее». Спорить с её вёрсткой больше
   * не нужно — карточки одинаковы по построению.
   *
   * Заодно из ответа убирается то, чего нет в наличии: раньше такие карточки
   * прятались уже на странице, и ряд оставался с дырами.
   */
  var КАРТОЧКИ_КЛЮЧ = 'ngr:cards';
  var ОСТАТКИ_КЛЮЧ = 'ngr:stockmap';
  var ЗАПАС_СВЕЖЕСТЬ = 30 * 60 * 1000;

  function изПамяти(ключ) {
    try {
      var s = JSON.parse(localStorage.getItem(ключ) || 'null');
      if (s && s.when && s.data) return s;
    } catch (e) {}
    return null;
  }
  function вПамять(ключ, data) {
    try { localStorage.setItem(ключ, JSON.stringify({ when: Date.now(), data: data })); } catch (e) {}
  }

  /*
   * Запасы держим в памяти браузера.
   *
   * Ответ Tilda правится на месте, синхронно, — ждать загрузки списка там
   * негде. Поэтому прошлый список лежит наготове, а свежий подтягивается
   * в фоне и работает со следующего запроса.
   */
  var НАШИ_ТОВАРЫ = (изПамяти(КАРТОЧКИ_КЛЮЧ) || {}).data || null;
  var ОСТАТКИ_КАРТА = (изПамяти(ОСТАТКИ_КЛЮЧ) || {}).data || null;
  /*
   * Цены — из нашего указателя, а не из копии Tilda.
   *
   * Копия цен внутри Tilda обновлялась ручной заливкой файла и замерла
   * на 03.08: к 17.08 сайт разъехался с кабинетом на всех 674 товарах, а на
   * тринадцати оказался дороже Ozon. Требование Александра: цены должны
   * обновляться сами и быть точными. Основа — цена по карте Ozon из отчёта
   * Repricer, свежесть держит воркер по текущей цене Ozon.
   */
  var ЦЕНЫ_КЛЮЧ = 'ngr:prices';
  var ЦЕНЫ_КАРТА = (изПамяти(ЦЕНЫ_КЛЮЧ) || {}).data || null;
  // Признак «витрина ещё не полна» читает пауза автозагрузчика: пока есть что
  // дорисовать, поиск важнее тишины на панели фильтров.
  window.NGR_ЕСТЬ_ЧТО_ДОБРАТЬ = !!(НАШИ_ТОВАРЫ && НАШИ_ТОВАРЫ.length);

  (function обновитьЗапасы() {
    var к = изПамяти(КАРТОЧКИ_КЛЮЧ);
    if (!к || Date.now() - к.when > ЗАПАС_СВЕЖЕСТЬ) {
      fetch(API + '/catalog/cards?f=2')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.items && j.items.length) {
            НАШИ_ТОВАРЫ = j.items;
            вПамять(КАРТОЧКИ_КЛЮЧ, j.items);
            window.NGR_ЕСТЬ_ЧТО_ДОБРАТЬ = true;
            // Список приехал позже обхода — просим ещё одну страницу, чтобы
            // было куда подмешать (иначе витрина останется урезанной).
            попроситьЕщёСтраницу();
          }
        })
        .catch(function () {});
    }
    var о = изПамяти(ОСТАТКИ_КЛЮЧ);
    if (!о || Date.now() - о.when > ЗАПАС_СВЕЖЕСТЬ) {
      fetch(API + '/catalog/stock')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.stock) { ОСТАТКИ_КАРТА = j.stock; вПамять(ОСТАТКИ_КЛЮЧ, j.stock); }
        })
        .catch(function () {});
    }
    // Цены живут короче остатков: держим их не дольше десяти минут.
    var ц = изПамяти(ЦЕНЫ_КЛЮЧ);
    if (!ц || Date.now() - ц.when > 10 * 60 * 1000) {
      fetch(API + '/catalog/prices')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.items && Object.keys(j.items).length > 50) {
            ЦЕНЫ_КАРТА = j.items; вПамять(ЦЕНЫ_КЛЮЧ, j.items);
          }
        })
        .catch(function () {});
    }
  })();

  // Что Tilda прислала и что мы добавили за текущий обход каталога.
  var виденныеТовары = {};
  var подмешанныеТовары = {};
  var доставленоTilda = 0;    // сколько товаров она отдала за обход
  var всегоУTilda = 0;        // сколько обещала в поле total

  function числоИзАдреса(u, имя) {
    var m = String(u).match(new RegExp('[?&]' + имя + '=(\\d+)'));
    return m ? Number(m[1]) : 0;
  }

  /*
   * Своё добавляем только в полную витрину.
   *
   * Признаков два, и оба нужны: наша метка (значит перечень брендов ставили
   * мы, а не покупатель) и отсутствие любых других отборов — формы выпуска,
   * страны, цены, поиска. Иначе в список найденного попадут посторонние
   * товары, и покупатель сочтёт их находками.
   */
  /*
   * Человек ищет по каталогу.
   *
   * Поле поиска Tilda ничего не спрашивает у сервера — оно прячет со страницы
   * то, что не подошло. Значит честная находка возможна только когда на
   * странице лежит вся витрина, а не первые её страницы.
   */
  function ищутВКаталоге() {
    // Действующий запрос считаем и по своей памяти: панель Tilda пересобирается
    // на каждой догрузке и стирает текст из поля, а искать человек не перестал.
    if (String(NGR_ЗАПРОС || '').trim().length >= 2) return true;
    if (String(НАБРАНО || '').trim().length >= 2) return true;
    var inp = document.querySelector('#rec2502703571 .js-catalog-filter-search') ||
              document.querySelector('input.js-catalog-filter-search');
    return !!(inp && String(inp.value).trim().length >= 2);
  }

  function обновитьПризнакДобора() {
    var осталось = 0;
    if (НАШИ_ТОВАРЫ) {
      for (var i = 0; i < НАШИ_ТОВАРЫ.length; i++) {
        var a = String(НАШИ_ТОВАРЫ[i].art || '');
        if (a && !виденныеТовары[a] && !подмешанныеТовары[a]) осталось++;
      }
    }
    window.NGR_ЕСТЬ_ЧТО_ДОБРАТЬ = осталось > 0;
  }

  function чистаяВыдача(url) {
    var u = String(url);
    if (u.indexOf('ngrall=1') < 0) return false;
    if (/[?&](q|query|search)=/.test(u)) return false;
    var прочие = u.replace(/filters%5B(quantity|brand)%5D[^&]*/g, '')
                  .replace(/filters\[(quantity|brand)\][^&]*/g, '');
    if (прочие.indexOf('filters%5B') > -1 || прочие.indexOf('filters[') > -1) return false;
    return true;
  }

  /*
   * Наш товар в том виде, в каком его понимает Tilda.
   *
   * Форму берём у её же товара из этого ответа: полей два десятка, и
   * выдумывать их значения — верный способ получить пустую карточку.
   * Заменяем только то, что относится к товару, а чужое описание и
   * характеристики образца обнуляем.
   */
  function товарДляTilda(образец, c) {
    var n = JSON.parse(JSON.stringify(образец));
    var uid = Number(c.uid) || 0;
    var цена = String(c.price) + '.0000';
    var старая = c.old ? String(c.old) : '';
    var остаток = String(c.left == null ? 10 : c.left);
    n.uid = uid;                     // у Tilda это число, а не строка
    n.sku = String(c.art);
    n.title = String(c.title || '');
    n.price = цена;
    n.priceold = старая;
    n.gallery = JSON.stringify([{ img: String(c.img || '') }]);
    n.url = String(c.url || '');
    n.quantity = остаток;
    n.externalid = '';
    n.text = '';
    n.descr = '';
    n.characteristics = [];
    n.mark = '';
    n.sort = 9000000;                // наши товары идут в конец списка
    /*
     * Главное поле — `editions`.
     *
     * Карточку Tilda рисует не по верхним полям товара, а по первому изданию.
     * Пока сюда попадало издание образца, все подмешанные карточки выходили
     * с чужим артикулом и чужой ценой: 26 товаров показывали 1 950 ₽
     * (замечено на боевом сайте 16.08, правка откатывалась).
     */
    n.editions = [{
      uid: uid, price: цена, priceold: старая,
      sku: String(c.art), quantity: остаток, img: String(c.img || '')
    }];
    return n;
  }

  /*
   * Список наших товаров ещё не приехал, а обход уже кончается.
   *
   * Тогда витрина осталась бы без дорисовки: на холодном заходе 17.08 так и
   * вышло — 610 карточек вместо 674. Не даём Tilda закрыть обход: обещаем ей,
   * что товары ещё есть, и оставляем кнопку «Загрузить ещё» на месте. Когда
   * список приедет, одно нажатие даст нам ответ, в который и подмешаем.
   */
  var ЖДЁМ_СПИСОК = false;

  function попроситьЕщёСтраницу() {
    if (!ЖДЁМ_СПИСОК) return;
    ЖДЁМ_СПИСОК = false;
    var б = document.querySelector('#rec2502703571 .js-catalog-load-more-btn') ||
            document.querySelector('.js-catalog-load-more-btn');
    if (б) б.click();
  }

  function подмешатьСвои(текст, url) {
    if (!ОСТАТКИ_КАРТА) return текст;
    if (!НАШИ_ТОВАРЫ) {
      // Держим обход открытым, пока список в пути.
      if (onCatalogPage() && чистаяВыдача(url)) {
        try {
          var ж = JSON.parse(текст);
          if (ж && ж.products && ж.products.length) {
            доставленоTilda += ж.products.length;
            ж.total = доставленоTilda + 1;
            ЖДЁМ_СПИСОК = true;
            return JSON.stringify(ж);
          }
        } catch (e) {}
      }
      return текст;
    }
    var j = JSON.parse(текст);
    var список = j.products;
    if (!список || !список.length) return текст;

    var слой = числоИзАдреса(url, 'slice') || 1;
    var размер = числоИзАдреса(url, 'size') || список.length;
    // Новый обход — забываем прошлый.
    if (слой <= 1) { виденныеТовары = {}; подмешанныеТовары = {}; доставленоTilda = 0; }
    доставленоTilda += список.length;
    if (Number(j.total)) всегоУTilda = Number(j.total);

    var было = список.length;
    /*
     * Артикула нет в снимке — значит остатка нет.
     *
     * Это правило витрины с самого начала: снимок перечисляет всё, что есть
     * у Ozon. Пока оно не было применено здесь, снятые с продажи товары
     * доезжали до страницы и прятались уже на ней — ряд оставался с дырами
     * (замечание Александра 16.08). Проверка на осмысленный размер снимка
     * нужна, чтобы обрезанный ответ не вычистил витрину целиком.
     */
    var снимокПолон = Object.keys(ОСТАТКИ_КАРТА).length > 50;
    var живые = список.filter(function (p) {
      var о = ОСТАТКИ_КАРТА[String(p.sku)];
      if (о == null) return !снимокПолон;
      return Number(о) >= MIN_STOCK;
    });
    живые.forEach(function (p) { виденныеТовары[String(p.sku)] = 1; });
    /*
     * Уже дорисованное вырезаем из поздних страниц Tilda.
     *
     * Пока дорисовка шла строго в конце обхода, встретиться они не могли.
     * С 17.08 дорисовка идёт ещё и по поиску, то есть посередине, — и тот же
     * товар Tilda пришлёт сама следующей страницей. Без этой строки он выйдет
     * дважды (так получилось 16.08: сначала 14 дублей, потом 409 лишних).
     */
    живые = живые.filter(function (p) { return !подмешанныеТовары[String(p.sku)]; });
    var убрано = было - живые.length;

    /*
     * Когда добавлять своё.
     *
     * Каталог Tilda отдаёт частями. Добавить на середине обхода нельзя: тот
     * же товар она пришлёт сама на следующей странице, и он задвоится —
     * проверено 16.08, сначала 14 дублей, потом 409 лишних карточек.
     * Поэтому в каталоге добавляем только когда обход закончен.
     *
     * Когда обход закончен — считаем, а не угадываем.
     *
     * Признак «страница короче запрошенной» обманул: на одной из страниц он
     * сработал в середине обхода, и витрина вывалила 409 товаров разом, а
     * потом Tilda прислала их же сама. Верный признак один: Tilda отдала
     * столько товаров, сколько сама обещала в поле total.
     */
    var конецОбхода = всегоУTilda > 0 && доставленоTilda >= всегоУTilda;
    /*
     * Поиск — второй повод дорисовать, не дожидаясь конца обхода.
     *
     * Иначе покупатель ищет по четверти витрины и получает «ничего не найдено»
     * на товар, которого 1700 штук (артикул 10754, замечание Александра 17.08).
     */
    var поискИдёт = onCatalogPage() && ищутВКаталоге();
    var сколько = 0;
    if (чистаяВыдача(url)) {
      // Ряд на главной — не обход, а один запрос: там дополняем сразу и
      // ровно взамен снятых с продажи, иначе в ряду остаются дыры.
      if (onCatalogPage()) сколько = (конецОбхода || поискИдёт) ? -1 : 0;
      else сколько = убрано;
    }

    var добавлено = 0;
    if (сколько !== 0) {
      var нет = НАШИ_ТОВАРЫ.filter(function (c) {
        return c.art && !виденныеТовары[String(c.art)] && !подмешанныеТовары[String(c.art)];
      });
      if (сколько > 0) нет = нет.slice(0, сколько);
      var образец = список[0];
      нет.forEach(function (c) {
        живые.push(товарДляTilda(образец, c));
        подмешанныеТовары[String(c.art)] = 1;
        добавлено++;
      });
    }

    /*
     * Остаток в ответе — живой, из Ozon.
     *
     * Требование Александра 17.08: «надо, чтобы Тильда выдавала то, что есть
     * фактически на Озоне без её додумывания, что чего-то нет». Своя копия
     * остатков у Tilda обновляется только ручной загрузкой файла и потому
     * врёт: у артикула 12933 в её карточке стоит ноль и надпись «Нет в
     * наличии», а в Ozon 262 штуки. Раз мы всё равно правим ответ, заодно
     * подставляем настоящий остаток каждому товару — и её собственная
     * разметка перестаёт обещать покупателю пустоту.
     *
     * Карточку Tilda рисует по первому изданию, поэтому правим и верхнее
     * поле, и издания.
     */
    if (снимокПолон) {
      живые.forEach(function (p) {
        var о = ОСТАТКИ_КАРТА[String(p.sku)];
        if (о == null) return;
        var строка = String(о);
        p.quantity = строка;
        if (p.editions && p.editions.length) {
          p.editions.forEach(function (и) { if (и) и.quantity = строка; });
        }
      });
    }

    /*
     * Цена в ответе — наша, а не замершая копия Tilda.
     *
     * Правило: цена продажи — по карте Ozon (решение Александра 03.08),
     * зачёркнутая — цена до скидки у Ozon. Число приходит от воркера уже
     * посчитанным, здесь только подстановка. Как и с остатком, правим и
     * верхнее поле, и издания: карточку Tilda рисует по первому изданию.
     */
    if (ЦЕНЫ_КАРТА) {
      живые.forEach(function (p) {
        var з = ЦЕНЫ_КАРТА[String(p.sku)];
        if (!з || !з.p) return;
        var цена = String(з.p) + '.0000';
        var старая = з.o && з.o > з.p ? String(з.o) : '';
        p.price = цена;
        p.priceold = старая;
        if (p.editions && p.editions.length) {
          p.editions.forEach(function (и) { if (и) { и.price = цена; и.priceold = старая; } });
        }
      });
    }

    j.products = живые;
    if (поискИдёт && !конецОбхода && добавлено) {
      /*
       * Дорисовали всё посередине обхода — для Tilda обход на этом закончен.
       * Если оставить её собственное `total`, она продолжит просить страницы и
       * пришлёт уже нарисованное. Считаем то, что реально на странице, плюс
       * этот ответ.
       */
      j.total = document.querySelectorAll('.js-product').length + живые.length;
    } else {
      j.total = Math.max(живые.length, (всегоУTilda || было) - убрано + добавлено);
    }
    обновитьПризнакДобора();
    return JSON.stringify(j);
  }

  /*
   * Ответ правим на месте: подменяем чтение responseText и response у
   * конкретного запроса. Так не важно, каким обработчиком Tilda читает ответ
   * и в каком порядке он навешан.
   */
  function перехватитьОтвет(xhr, url) {
    if (typeof url !== 'string' || url.indexOf('getproductslist') < 0) return;
    var готовое = null;
    var читать = function (описание) {
      var сырое = описание.get.call(xhr);
      if (xhr.readyState !== 4 || typeof сырое !== 'string') return сырое;
      if (готовое === null) {
        // Что бы ни случилось — покупатель должен увидеть каталог.
        try { готовое = подмешатьСвои(сырое, url); } catch (e) { готовое = сырое; }
      }
      return готовое;
    };
    ['responseText', 'response'].forEach(function (имя) {
      var описание = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, имя);
      if (!описание || !описание.get) return;
      try {
        Object.defineProperty(xhr, имя, {
          configurable: true,
          get: function () { return читать(описание); }
        });
      } catch (e) {}
    });
  }

  function askOnlyInStock() {
    // Выключатель для проверки: с ?ngr=off страница работает так, будто
    // поправки нет. Нужен, чтобы отличать наши поломки от чужих.
    if (/[?&]ngr=off/.test(location.search)) return;
    if (window.NGR_STOCK_QUERY) return;
    window.NGR_STOCK_QUERY = 1;
    function fix(u) {
      if (typeof u !== 'string' || u.indexOf('getproductslist') < 0) return u;
      /*
       * Просим только то, что есть в наличии, и перечисляем бренды.
       *
       * 16.08 перечисление брендов сняли: замер показал «в наличии 1185
       * товаров, а с брендами доезжает 729», и трюк выглядел вредным.
       * Замер был обманчив. 1185 — это счётчик, который Tilda печатает
       * в поле total; товаров по такому запросу она отдаёт 277 и на
       * четвёртой странице заканчивает (проверено 16.08 при size=300 и
       * при size=60). Сравнивали обещание с фактом.
       *
       * На деле перечисление брендов — единственный известный способ увести
       * запрос со «застрявшего» указателя раздела на свежий. Проверено в тот
       * же день: без фильтров Tilda отдаёт 601 карточку, с диапазоном цен —
       * те же 601, с одной сортировкой — 198, и только перечисление брендов
       * даёт 1340. Поэтому оно вернулось, но список берётся живым (см. выше),
       * а не зашитым — из-за зашитого нового бренда и потеряли бы.
       *
       * Что видит покупатель (карточки с остатком от 4, замер 16.08):
       *   только «в наличии»    — 237 из 613;
       *   бренды + «в наличии»  — 588 из 613;
       *   только бренды         — 612 из 613, но приходит 1340 карточек,
       *                           из них 728 скрывается остатком.
       * Оставляем «в наличии»: 141 скрытая карточка вместо 728, иначе
       * листалка Tilda снова начнёт обрываться на полупустой странице
       * (замечание Александра 08.08). Хвост из 25 позиций доберём, когда
       * источником каталога станет указатель воркера.
       */
      if (u.indexOf('filters%5Bquantity%5D') < 0 && u.indexOf('filters[quantity]') < 0) {
        u += (u.indexOf('?') < 0 ? '?' : '&') + 'filters%5Bquantity%5D=y';
      }
      // Бренд, выбранный покупателем в фильтре, не трогаем — иначе выбор
      // «показать только NOW» превратился бы в «показать всё».
      if (ЗАПРОС_БРЕНДОВ &&
          u.indexOf('filters%5Bbrand%5D') < 0 && u.indexOf('filters[brand]') < 0) {
        u += (u.indexOf('?') < 0 ? '?' : '&') + ЗАПРОС_БРЕНДОВ;
        // Метка «это вся витрина, а не выбор покупателя». По ней ответ узнаёт,
        // можно ли добавлять свои товары: в отобранный список добавлять
        // нельзя — покупатель решит, что это тоже находки.
        u += '&ngrall=1';
      }
      // Размер страницы увеличиваем только при смене сортировки на самой
      // странице. На первой загрузке (getallparts) Tilda из большого ответа
      // рисовала восемь карточек вместо ста шестидесяти — её отрисовка
      // рассчитывает на тот размер, который просила сама.
      if (/sort%5B|sort\[/.test(u) && u.indexOf('getallparts') < 0) {
        u = u.replace(/([?&])size=\d+/, '$1size=300');
      }
      return u;
    }
    var of = window.fetch;
    if (of) {
      window.fetch = function (u, o) {
        try { u = fix(u); } catch (e) {}
        return of.call(this, u, o);
      };
      try { обновитьБренды(of); } catch (e) {}
    }
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      var rest = [].slice.call(arguments, 2);
      try { u = fix(u); } catch (e) {}
      try { перехватитьОтвет(this, u); } catch (e) {}
      return ox.apply(this, [m, u].concat(rest));
    };
  }
  askOnlyInStock();
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
   * то, что снято с продажи в Ozon, и малые остатки: склад может разойтись
   * на маркетплейсе раньше, чем соберём заказ с сайта.
   *
   * Порог задаёт Александр:
   * 07.08.2026 — до 3 штук включительно не показывать;
   * 17.08.2026 — «опусти до 2х штук», то есть скрываем только 0 и 1.
   * По снимку остатков это 675 товаров на витрине вместо 611.
   *
   * Значение одно на весь скрипт: тем же порогом отбирается ответ каталога и
   * решается, доступна ли кнопка «В корзину» в карточке товара.
   *
   * Пока список не загружен — не трогаем ничего: пустая витрина из-за сбоя
   * сети хуже, чем лишняя карточка.
   */
  var MIN_STOCK = 2;

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

  /* NGR_PROMO_RECOVERY_BEGIN */
  // ОТКЛЮЧЕНО 12.08.2026 (решение после инцидента с «полуприменённым» промокодом).
  // Компонент пересоздавал родное поле Tilda со своей инициализацией; после
  // этого «Применить» срабатывал наполовину: Tilda рисовала строки скидки
  // в итогах, но в корзину (tcart.promocode/amount) код не записывала —
  // покупатель видел цену со скидкой, а к оплате уходила полная. Замер
  // Александра 12.08: итоги «Промокод: 50%, Итоговая 1 168», при этом
  // tcart = {amount: 2336, prodamount: 2336, promocode: undefined}.
  // До переработки под живым браузером промокодами управляет только сама
  // Tilda — её штатный поток пишет скидку в корзину целиком.
  var PROMO_RECOVERY_ENABLED = false;
  var PROMO_GROUP_SELECTOR =
    '.t706__orderform .t-input-group_pc[data-field-type="pc"],' +
    'form[data-formcart="y"] .t-input-group_pc[data-field-type="pc"],' +
    '.t-store__cart-form .t-input-group_pc[data-field-type="pc"]';
  var promoStates = new WeakMap();
  var promoNativeInputs = new WeakSet();
  var promoMessageSeq = 0;

  function promoNumber(value) {
    // parseFloat вместо Number: Tilda хранит скидку и как число, и как строку
    // вида «50%» или «1 168,5» — Number на них даёт NaN, и применённый промокод
    // выглядел как «без скидки» (инцидент 12.08: скидка в итогах есть, поле
    // красное, оформление заблокировано).
    var s = String(value === undefined || value === null ? '' : value)
      .replace(/\s+/g, '').replace(',', '.');
    var n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  var PROMO_DISCOUNT_FIELDS = ['discountsum', 'discountpercent', 'discount', 'discountprice'];

  function positivePromoObject(promo) {
    if (!promo || typeof promo !== 'object') return false;
    var present = [];
    for (var i = 0; i < PROMO_DISCOUNT_FIELDS.length; i++) {
      var v = promo[PROMO_DISCOUNT_FIELDS[i]];
      if (v === undefined || v === null || String(v) === '') continue;
      if (promoNumber(v) > 0) return true;
      present.push(PROMO_DISCOUNT_FIELDS[i]);
    }
    // Поля скидки есть, и все нули — честный случай «код принят, но для этой
    // корзины скидки не даёт»: остаёмся в редакторе с пояснением.
    if (present.length) return false;
    // Полей скидки нет вовсе — не гадаем за Tilda: раз код лежит в корзине,
    // считаем его применённым (сумму всё равно считает Tilda, не мы).
    return !!String(promo.promocode || '').trim();
  }

  /** Read-only: the recovery component never installs, removes or recalculates a promo. */
  function activePositivePromo() {
    var cart = window.tcart;
    var cartPromo = cart && cart.promocode;
    // Инцидент 12.08 (повторно): скидка видна в итогах Tilda, а детектор
    // не признавал код применённым, потому что смотрел только внутрь объекта
    // tcart.promocode. Tilda хранит применённый код по-разному: строкой,
    // объектом с полями скидки, объектом без них — а сумму скидки может
    // держать на верхнем уровне корзины (prodamount_discountsum) или уже
    // вычтенной из amount против prodamount. Признаём код применённым, если
    // Tilda сама его записала в корзину, каким бы способом ни хранила.
    if (typeof cartPromo === 'string' && cartPromo.trim()) {
      return { promocode: cartPromo.trim() };
    }
    if (positivePromoObject(cartPromo)) return cartPromo;
    if (cartPromo && typeof cartPromo === 'object' &&
        String(cartPromo.promocode || '').trim() && cart &&
        (promoNumber(cart.prodamount_discountsum) > 0 ||
         (promoNumber(cart.prodamount) > 0 && promoNumber(cart.amount) > 0 &&
          promoNumber(cart.amount) < promoNumber(cart.prodamount)))) {
      // Поля скидки в объекте нулевые/устаревшие, но корзина реально ужата —
      // верим корзине, а не полям.
      return cartPromo;
    }
    var heldPromo = window.cartCalculator && window.cartCalculator.appliedPromocode;
    if (typeof heldPromo === 'string' && heldPromo.trim()) {
      return { promocode: heldPromo.trim() };
    }
    if (positivePromoObject(heldPromo)) return heldPromo;
    // No t_cart__promocode global exists in the Tilda 1.1 runtime currently loaded by NutryGo.
    return null;
  }

  function promoStateFor(group) {
    var state = promoStates.get(group);
    if (!state) {
      state = {
        bound: false,
        seq: 0,
        pending: false,
        lastValue: '',
        observer: null,
        wrapper: null
      };
      promoStates.set(group, state);
    }
    return state;
  }

  function promoInput(group) {
    return group && group.querySelector('.t-inputpromocode');
  }

  function promoWrapper(group) {
    return group && group.querySelector('.t-inputpromocode__wrapper');
  }

  function promoBusy(group) {
    return window.t_promocode_load === 'y' ||
      !!(group && group.querySelector('.t-inputpromocode__btn.t-btn_sending'));
  }

  function promoError(group, input) {
    var error = group.querySelector('.ngr-promo-error');
    if (!error) {
      var host = group.querySelector('.t-input-block') || group;
      error = document.createElement('div');
      error.className = 'ngr-promo-error';
      error.id = 'ngr-promo-error-' + (++promoMessageSeq);
      error.hidden = true;
      error.setAttribute('role', 'alert');
      error.setAttribute('aria-live', 'polite');
      host.appendChild(error);
    }
    if (input) {
      var described = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (described.indexOf(error.id) < 0) {
        described.push(error.id);
        input.setAttribute('aria-describedby', described.join(' '));
      }
    }
    return error;
  }

  function hidePromoError(group) {
    var input = promoInput(group);
    var error = group.querySelector('.ngr-promo-error');
    if (input) input.removeAttribute('aria-invalid');
    if (error) {
      error.hidden = true;
      error.textContent = '';
    }
  }

  function showPromoError(group, message) {
    var input = promoInput(group);
    var error = promoError(group, input);
    if (input) input.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
  }

  function promoTarget(target, selector, group) {
    var node = target;
    while (node && node !== group) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function promoDispatch(input, type) {
    if (!input || typeof input.dispatchEvent !== 'function' || typeof Event !== 'function') return;
    try { input.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) {}
  }

  function updatePromoClear(group) {
    var state = promoStateFor(group);
    var input = promoInput(group);
    var clear = group.querySelector('.ngr-promo-clear');
    if (!clear) return;
    clear.disabled = !input || !String(input.value || '').length || state.pending || promoBusy(group);
    clear.setAttribute('aria-disabled', clear.disabled ? 'true' : 'false');
  }

  function ensurePromoControls(group) {
    var input = promoInput(group);
    var wrapper = promoWrapper(group);
    if (!input || !wrapper) return;
    group.classList.add('ngr-promo-editable');
    promoError(group, input);

    var applyButton = wrapper.querySelector('.t-inputpromocode__btn');
    if (applyButton) {
      applyButton.setAttribute('role', 'button');
      if (!applyButton.hasAttribute('tabindex')) applyButton.setAttribute('tabindex', '0');
    }

    var clear = wrapper.querySelector('.ngr-promo-clear');
    if (!clear) {
      clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'ngr-promo-clear';
      clear.textContent = 'Очистить';
      clear.setAttribute('aria-label', 'Очистить поле промокода');
      wrapper.appendChild(clear);
    }
    updatePromoClear(group);
  }

  function promoRecordId(group) {
    var node = group;
    while (node) {
      if (node.id && /^rec\d+$/.test(node.id)) return node.id.slice(3);
      node = node.parentNode;
    }
    return '';
  }

  function initRestoredPromo(group, input) {
    if (!input || input.getAttribute('data-ngr-promo-restored') !== '1') return true;
    if (promoNativeInputs.has(input)) return true;
    if (typeof window.t_input_promocode_init !== 'function') return false;
    var recordId = promoRecordId(group);
    var inputLid = group.getAttribute('data-input-lid') || '';
    if (!recordId || !inputLid) return false;
    try {
      window.t_input_promocode_init(recordId, inputLid);
      promoNativeInputs.add(input);
      return true;
    } catch (e) {
      return false;
    }
  }

  function markPromoPending(group, pending) {
    var state = promoStateFor(group);
    state.pending = pending;
    if (pending) group.setAttribute('aria-busy', 'true');
    else group.removeAttribute('aria-busy');
    updatePromoClear(group);
  }

  function renderAppliedPromo(group, promo) {
    var state = promoStateFor(group);
    state.pending = false;
    group.removeAttribute('aria-busy');
    group.classList.remove('ngr-promo-editable');
    hidePromoError(group);
    var wrapper = promoWrapper(group);
    if (wrapper && promoInput(group)) {
      wrapper.textContent = '';
      var text = document.createElement('div');
      text.className = 't-text ngr-promo-applied';
      text.textContent = promo && promo.promocode
        ? 'Промокод ' + String(promo.promocode) + ' активирован.'
        : 'Промокод активирован.';
      wrapper.appendChild(text);
    }
    var title = group.querySelector('.t-input-title.t-descr.t-descr_md');
    if (title) title.style.visibility = 'hidden';
  }

  function createRestoredPromoInput(group) {
    var state = promoStateFor(group);
    var wrapper = promoWrapper(group);
    if (!wrapper || activePositivePromo()) return null;
    var inputLid = group.getAttribute('data-input-lid') || '';
    wrapper.textContent = '';

    var input = document.createElement('input');
    input.type = 'text';
    input.name = 'Промокод';
    input.className = 't-input t-inputpromocode js-tilda-rule';
    input.value = state.lastValue || '';
    input.placeholder = 'Введите промокод';
    input.autocomplete = 'off';
    input.setAttribute('data-tilda-rule', 'promocode');
    input.setAttribute('data-ngr-promo-restored', '1');
    if (inputLid) input.setAttribute('aria-labelledby', 'field-title_' + inputLid);

    var applyButton = document.createElement('div');
    applyButton.className = 't-inputpromocode__btn t-btn t-btn_md';
    applyButton.textContent = 'Применить';
    applyButton.setAttribute('role', 'button');
    applyButton.setAttribute('tabindex', '0');

    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ngr-promo-clear';
    clear.textContent = 'Очистить';
    clear.setAttribute('aria-label', 'Очистить поле промокода');

    wrapper.appendChild(input);
    wrapper.appendChild(applyButton);
    wrapper.appendChild(clear);
    group.classList.add('ngr-promo-editable');
    var title = group.querySelector('.t-input-title.t-descr.t-descr_md');
    if (title && title.style && typeof title.style.removeProperty === 'function') {
      title.style.removeProperty('visibility');
    }
    promoError(group, input);
    updatePromoClear(group);
    return input;
  }

  function restorePromoEditor(group, message) {
    if (activePositivePromo()) {
      renderAppliedPromo(group, activePositivePromo());
      return;
    }
    markPromoPending(group, false);
    var input = promoInput(group) || createRestoredPromoInput(group);
    if (!input) return;
    ensurePromoControls(group);
    if (!initRestoredPromo(group, input)) {
      showPromoError(group, 'Не удалось подготовить поле промокода. Закройте и снова откройте корзину.');
      return;
    }
    showPromoError(group, message);
    updatePromoClear(group);
    var panel = group.querySelector('.ngr-promo-panel');
    if (!panel || !panel.hidden) {
      setTimeout(function () {
        if (!input.isConnected || activePositivePromo()) return;
        try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (x) {} }
        try { input.select(); } catch (e) {}
      }, 0);
    }
  }

  function settlePromo(group, seq) {
    if (!group || !group.isConnected) return;
    var state = promoStateFor(group);
    if (seq !== undefined && seq !== state.seq) return;
    if (promoBusy(group)) return;
    var positive = activePositivePromo();
    if (positive) {
      renderAppliedPromo(group, positive);
      return;
    }
    var input = promoInput(group);
    if (input) {
      if (state.pending) {
        markPromoPending(group, false);
        ensurePromoControls(group);
        showPromoError(group, 'Промокод не применён. Проверьте код или срок действия и попробуйте ещё раз.');
      }
      return;
    }
    var wrapper = promoWrapper(group);
    if (state.pending || (wrapper && wrapper.querySelector('.t-text'))) {
      restorePromoEditor(group,
        'Этот промокод не даёт скидку для товаров в корзине. Очистите поле или введите другой код.');
    }
  }

  function waitPromoSettlement(group, seq, tick) {
    setTimeout(function () {
      if (!group || !group.isConnected) return;
      var state = promoStateFor(group);
      if (state.seq !== seq || !state.pending) return;
      if (promoBusy(group)) {
        if (tick === 375) {
          showPromoError(group, 'Проверка промокода занимает больше обычного. Дождитесь ответа.');
        }
        // After 30 seconds keep one slow waiter alive. Native XHR has no public cancel/reset API;
        // stopping here would leave Clear disabled forever when a late error keeps the input in DOM.
        waitPromoSettlement(group, seq, tick + 1);
        return;
      }
      settlePromo(group, seq);
    }, tick ? (tick > 375 ? 1000 : 80) : 0);
  }

  function observePromoWrapper(group) {
    var state = promoStateFor(group);
    var wrapper = promoWrapper(group);
    if (!wrapper || state.wrapper === wrapper) return;
    if (state.observer) state.observer.disconnect();
    state.wrapper = wrapper;
    state.observer = new MutationObserver(function () {
      if (!promoBusy(group)) settlePromo(group, state.seq);
    });
    state.observer.observe(wrapper, { childList: true });
  }

  function bindPromoGroup(group) {
    var state = promoStateFor(group);
    if (state.bound) return;
    state.bound = true;

    group.addEventListener('input', function (event) {
      if (!event.target || !event.target.matches || !event.target.matches('.t-inputpromocode')) return;
      state.lastValue = event.target.value || '';
      hidePromoError(group);
      updatePromoClear(group);
    });

    group.addEventListener('keydown', function (event) {
      var applyButton = promoTarget(event.target, '.t-inputpromocode__btn', group);
      if (!applyButton || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      applyButton.click();
    });

    group.addEventListener('click', function (event) {
      var clear = promoTarget(event.target, '.ngr-promo-clear', group);
      if (clear) {
        event.preventDefault();
        var positive = activePositivePromo();
        if (positive) {
          renderAppliedPromo(group, positive);
          return;
        }
        if (state.pending || promoBusy(group)) return;
        var input = promoInput(group);
        if (!input) return;
        input.value = '';
        state.lastValue = '';
        hidePromoError(group);
        promoDispatch(input, 'input');
        promoDispatch(input, 'change');
        updatePromoClear(group);
        try { input.focus({ preventScroll: true }); } catch (e) { try { input.focus(); } catch (x) {} }
        return;
      }

      var applyButton = promoTarget(event.target, '.t-inputpromocode__btn', group);
      if (!applyButton || state.pending) return;
      var input = promoInput(group);
      if (!input) return;
      state.lastValue = input.value || '';
      state.seq += 1;
      hidePromoError(group);
      if (!String(state.lastValue).trim()) {
        showPromoError(group, 'Введите промокод.');
        updatePromoClear(group);
        return;
      }
      markPromoPending(group, true);
      waitPromoSettlement(group, state.seq, 0);
    });
  }

  function promoCss() {
    if (document.getElementById('ngr-promo-recovery-css')) return;
    var style = document.createElement('style');
    style.id = 'ngr-promo-recovery-css';
    style.textContent =
      '.ngr-promo-editable .t-inputpromocode__wrapper{display:grid!important;' +
      'grid-template-columns:minmax(0,1fr) auto auto!important;gap:8px!important;' +
      'align-items:stretch!important;width:100%!important;min-width:0!important;box-sizing:border-box!important}' +
      '.ngr-promo-editable .t-inputpromocode{width:100%!important;min-width:0!important;' +
      'max-width:100%!important;box-sizing:border-box!important}' +
      '.ngr-promo-editable .t-inputpromocode__btn,.ngr-promo-editable .ngr-promo-clear{' +
      'min-height:44px!important;box-sizing:border-box!important;align-items:center;justify-content:center}' +
      '.ngr-promo-clear{border:1px solid #cfd7e2;border-radius:10px;background:#fff;color:#35506f;' +
      'padding:0 14px;font-family:inherit;font-size:14px;font-weight:600;line-height:1.2;cursor:pointer}' +
      '.ngr-promo-clear:hover:not(:disabled){background:#f4f7fa}' +
      '.ngr-promo-clear:disabled{opacity:.5;cursor:not-allowed}' +
      '.ngr-promo-clear:focus-visible,.ngr-promo-editable .t-inputpromocode__btn:focus-visible{' +
      'outline:2px solid #2878c8!important;outline-offset:2px!important}' +
      '.ngr-promo-error{margin-top:8px;color:#a11b1b;font-size:13px;line-height:1.4}' +
      '.ngr-promo-error[hidden]{display:none!important}' +
      '.ngr-promo-applied{font-weight:600}' +
      '@media(max-width:640px){.ngr-promo-editable .t-inputpromocode{font-size:16px!important}}' +
      '@media(max-width:420px){.ngr-promo-editable .t-inputpromocode__wrapper{' +
      'grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important}' +
      '.ngr-promo-editable .t-inputpromocode{grid-column:1/-1!important}' +
      '.ngr-promo-editable .t-inputpromocode__btn{grid-column:1!important;width:100%!important;min-width:0!important}' +
      '.ngr-promo-editable .ngr-promo-clear{grid-column:2!important;width:100%!important;min-width:0!important}}';
    document.head.appendChild(style);
  }

  function fixPromocode() {
    if (!PROMO_RECOVERY_ENABLED) return;
    promoCss();
    document.querySelectorAll(PROMO_GROUP_SELECTOR).forEach(function (group) {
      bindPromoGroup(group);
      observePromoWrapper(group);
      var positive = activePositivePromo();
      if (positive) {
        renderAppliedPromo(group, positive);
        return;
      }
      var input = promoInput(group);
      if (input) {
        ensurePromoControls(group);
        if (input.getAttribute('data-ngr-promo-restored') === '1') initRestoredPromo(group, input);
        return;
      }
      var state = promoStateFor(group);
      var wrapper = promoWrapper(group);
      if (!promoBusy(group) && (state.pending || (wrapper && wrapper.querySelector('.t-text')))) {
        settlePromo(group, state.seq);
      }
    });
  }
  /* NGR_PROMO_RECOVERY_END */

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
  var SEARCH_INPUT = '#rec2502703571 .t-catalog__filter__search input, ' +
    '#rec2502703571 .t-store__filter__search input, ' +
    '#rec2502703571 .t-catalog__search-wrapper input, ' +
    '#rec2502703571 input.js-catalog-filter-search';
  var searchState = null;
  var searchBlurTimer = null;
  var searchRestoreQueued = false;
  var searchRestoreTimers = [];

  function searchInput() { return document.querySelector(SEARCH_INPUT); }

  function clearSearchRestoreState() {
    searchState = null;
    clearTimeout(searchBlurTimer);
    searchBlurTimer = null;
    searchRestoreTimers.forEach(clearTimeout);
    searchRestoreTimers = [];
    // Уже поставленный requestAnimationFrame сам завершится без фокуса:
    // restore() повторно проверяет searchState перед любым действием.
    searchRestoreQueued = false;
  }

  function initSearchGuard() {
    if (window.__ngrSearchGuard) return;
    window.__ngrSearchGuard = 1;

    document.addEventListener('focusin', function (e) {
      var el = e.target;
      if (!el || !el.matches || !el.matches(SEARCH_INPUT)) return;
      clearTimeout(searchBlurTimer);
      searchState = {
        value: el.value || '',
        start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
        end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
        width: window.innerWidth,
        active: true,
        composing: false
      };
    }, true);

    document.addEventListener('input', function (e) {
      var el = e.target;
      if (!el || !el.matches || !el.matches(SEARCH_INPUT)) return;
      if (!searchState) searchState = { width: window.innerWidth };
      searchState.value = el.value || '';
      searchState.start = typeof el.selectionStart === 'number' ? el.selectionStart : null;
      searchState.end = typeof el.selectionEnd === 'number' ? el.selectionEnd : null;
      searchState.active = true;
      searchState.composing = !!e.isComposing;
    }, true);

    document.addEventListener('compositionstart', function (e) {
      if (e.target && e.target.matches && e.target.matches(SEARCH_INPUT) && searchState) {
        searchState.composing = true;
      }
    }, true);
    document.addEventListener('compositionend', function (e) {
      if (e.target && e.target.matches && e.target.matches(SEARCH_INPUT) && searchState) {
        searchState.composing = false;
        searchState.value = e.target.value || '';
      }
    }, true);

    document.addEventListener('focusout', function (e) {
      if (!e.target || !e.target.matches || !e.target.matches(SEARCH_INPUT)) return;
      clearTimeout(searchBlurTimer);
      searchBlurTimer = setTimeout(function () {
        var a = document.activeElement;
        if (a && a !== document.body && a !== document.documentElement &&
            (!a.matches || !a.matches(SEARCH_INPUT)) &&
            (!a.closest || !a.closest('.ngr-smart-search'))) searchState = null;
      }, 650);
    }, true);

    // Явный тап вне поиска — это решение покупателя, фокус не возвращаем.
    document.addEventListener('pointerdown', function (e) {
      if (!searchState || !e.target || !e.target.closest) return;
      if (!e.target.closest('.t-catalog__filter__search, .ngr-smart-search')) searchState = null;
    }, true);

    // Закрыл сам — забываем состояние и больше не возвращаем панель.
    document.addEventListener('click', function (e) {
      var el = e.target;
      if (el && el.closest && el.closest('.js-catalog-search-mob-close-btn, .t-catalog__filter__search-mob-close-btn')) {
        searchState = null;
      }
    }, true);

    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Tab') && e.target && e.target.matches && e.target.matches(SEARCH_INPUT)) {
        searchState = null;
      }
    }, true);

    function keepSearchDuringViewportResize() {
      if (!searchState || !searchState.active) return;
      searchRestoreTimers.forEach(clearTimeout);
      searchRestoreTimers = [0, 60, 140, 280, 520, 900, 1500].map(function (ms) {
        return setTimeout(fixSearch, ms);
      });
    }
    window.addEventListener('resize', keepSearchDuringViewportResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', keepSearchDuringViewportResize, { passive: true });
    }
  }

  function fixSearch() {
    if (!searchState || !searchState.active || searchState.composing) return;
    // clientWidth не меняется при появлении экранной клавиатуры и iOS zoom.
    // При настоящем повороте экрана старое состояние возвращать не нужно.
    if (window.innerWidth !== searchState.width) { searchState = null; return; }
    var inp = searchInput();
    if (inp && document.activeElement === inp && inp.value === searchState.value) return; // всё на месте
    if (!inp || !inp.getBoundingClientRect().width || searchRestoreQueued) return;
    searchRestoreQueued = true;
    var restore = function () {
      searchRestoreQueued = false;
      if (!searchState || !searchState.active) return;
      var current = searchInput();
      if (!current || !current.getBoundingClientRect().width) return;
      if (current.value !== searchState.value) current.value = searchState.value;
      try { current.focus({ preventScroll: true }); } catch (e) { current.focus(); }
      if (searchState.start !== null && current.setSelectionRange) {
        try { current.setSelectionRange(searchState.start, searchState.end); } catch (e) {}
      }
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(restore);
    else window.setTimeout(restore, 0);
  }

  /* ---------- Умный поиск по каталогу ---------- */

  /*
   * Указатель поиска берём у воркера, а не из выложенного файла.
   *
   * Файл собирался скриптом и выкладывался руками — и отстал: собранный 10.08,
   * он не знал 25 товаров из 674, включая артикул 12933, которого в Ozon
   * 262 штуки. Поиск по артикулу для них не работал вовсе (замечание
   * Александра 17.08). Воркер собирает указатель из тех же данных, что и
   * витрина, поэтому отстать больше не может.
   */
  var SMART_SEARCH_INDEX = window.NGR_SEARCH_INDEX ||
    'https://nutrygo-integrator.pikhtovnikov-alieksandr.workers.dev/catalog/searchindex';
  var smartIndexPromise = null;

  function smartNorm(s) {
    s = String(s || '').toLocaleLowerCase('ru').replace(/ё/g, 'е');
    try { s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
    return s.replace(/[^a-zа-я0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  function keyboardVariant(s) {
    var en = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
    var ru = 'йцукенгшщзхъфывапролджэячсмитьбю';
    var out = '', changed = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i), p = en.indexOf(c), r = ru.indexOf(c);
      if (p > -1) { out += ru.charAt(p); changed = true; }
      else if (r > -1) { out += en.charAt(r); changed = true; }
      else out += c;
    }
    return changed ? smartNorm(out) : '';
  }

  // «beta karotin» → «бета каротин». Это не словарь медицинских обещаний,
  // а только механическая транслитерация запроса; исходный вариант ищем тоже.
  function translitVariant(s) {
    if (!/[a-z]/i.test(s)) return '';
    var pairs = [
      ['shch', 'щ'], ['sch', 'щ'], ['yo', 'ё'], ['zh', 'ж'], ['kh', 'х'],
      ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'], ['yu', 'ю'], ['ya', 'я'],
      ['ye', 'е'], ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'],
      ['d', 'д'], ['e', 'е'], ['z', 'з'], ['i', 'и'], ['j', 'й'],
      ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'],
      ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'],
      ['f', 'ф'], ['h', 'х'], ['c', 'к'], ['y', 'ы'], ['q', 'к'], ['w', 'в'], ['x', 'кс']
    ];
    var out = smartNorm(s);
    pairs.forEach(function (p) { out = out.replace(new RegExp(p[0], 'g'), p[1]); });
    return smartNorm(out);
  }

  function smartStem(w) {
    if (w.length < 5) return w;
    return w.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|ая|яя|ое|ее|ые|ие|ий|ый|ой|ам|ям|ах|ях|ом|ем|ов|ев|ы|и|а|я|у|ю|е|о)$/i, '');
  }

  function smartTokens(s) {
    var stop = { 'для': 1, 'или': 1, 'при': 1, 'под': 1, 'над': 1, 'без': 1, 'это': 1 };
    return smartNorm(s).split(' ').filter(function (w) { return w.length > 1 && !stop[w]; });
  }

  function oneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a.charAt(i) === b.charAt(j)) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else { i++; j++; }
    }
    return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
  }

  function tokenScore(token, words) {
    var stem = smartStem(token), best = 0;
    /*
     * Числа сверяем только точно.
     *
     * Терпимость к одной опечатке нужна словам — «магнй» должно находить
     * «магний». На числах она работает против покупателя: артикул 10754
     * отличается от 10764 одним знаком, и по запросу артикула выходили два
     * товара (замечание Александра 17.08 со снимком выдачи). Дозировку это
     * не ломает: «1000» по-прежнему совпадает со словом «1000» в названии.
     */
    var числоЦеликом = /^\d+$/.test(token);
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w === token) return 120;
      if (числоЦеликом) continue;
      if (Math.min(w.length, token.length) >= 4 && (w.indexOf(token) === 0 || token.indexOf(w) === 0)) best = Math.max(best, 85);
      if (stem.length >= 4 && smartStem(w) === stem) best = Math.max(best, 65);
      if (token.length >= 4 && Math.abs(w.length - token.length) <= 1 && oneEdit(token, w)) best = Math.max(best, 45);
    }
    return best;
  }

  function rankSmart(item, query) {
    var title = item._t || (item._t = smartNorm(item.t));
    var brand = item._b || (item._b = smartNorm(item.b));
    var text = item.s || '';
    var q = smartNorm(query), art = smartNorm(item.a);
    if (!q) return null;
    if (art === q) return { score: 12000, match: 'Артикул' };
    var score = 0, match = 'Описание';
    if (title === q) { score += 9000; match = 'Название'; }
    else if (title.indexOf(q) === 0) { score += 6500; match = 'Название'; }
    else if (title.indexOf(q) > -1) { score += 4800; match = 'Название'; }
    if (brand === q) { score += 4200; match = 'Бренд'; }
    else if (brand.indexOf(q) === 0) { score += 3200; match = 'Бренд'; }
    if (text.indexOf(q) > -1) score += 2100;

    var tokens = smartTokens(q);
    if (!tokens.length) return score ? { score: score, match: match } : null;
    var tw = title.split(' '), bw = brand.split(' '), sw = text.split(' ');
    var matched = 0;
    tokens.forEach(function (tok) {
      var ts = tokenScore(tok, tw), bs = tokenScore(tok, bw), ds = tokenScore(tok, sw);
      var best = Math.max(ts, bs, ds);
      if (best) matched++;
      if (best === ts && ts) { score += ts * 8; if (match === 'Описание') match = 'Название'; }
      else if (best === bs && bs) { score += bs * 6; if (match === 'Описание') match = 'Бренд'; }
      else score += ds * 2;
    });
    var need = tokens.length < 3 ? tokens.length : Math.ceil(tokens.length * 0.67);
    return matched >= need && score > 0 ? { score: score, match: match } : null;
  }

  /**
   * Характеристики и описания из кабинета Ozon.
   *
   * В каталоге Tilda описания нет: в указателе оно есть у 277 товаров из
   * 729, у остальных 452 поле пустое. Поэтому поиск и находил только по
   * названию (замечание Александра 14.08). Настоящий текст живёт у Ozon —
   * воркер забирает его оттуда и отдаёт одной строкой на артикул, а мы
   * подмешиваем её в тот же указатель, по которому уже ищем.
   *
   * Если прибавка не пришла, поиск работает как раньше: она не обязательна.
   */
  function loadSmartIndex() {
    if (!smartIndexPromise) {
      var основа = fetch(SMART_SEARCH_INDEX, { credentials: 'omit', cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { return (j && j.items) || []; });
      var прибавка = fetch(API + '/catalog/searchtext', { credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return (j && j.items) || null; })
        .catch(function () { return null; });
      smartIndexPromise = Promise.all([основа, прибавка]).then(function (пара) {
        var items = пара[0], доп = пара[1];
        if (доп) {
          items.forEach(function (it) {
            var t = доп[String(it.a)];
            if (!t) return;
            // Кладём в тот же нормализованный текст, по которому идёт поиск,
            // и в подпись — чтобы человек видел, почему товар нашёлся.
            it.s = (it.s || '') + ' ' + smartNorm(t);
            if (!it.d) it.d = t.slice(0, 180);
          });
        }
        return items;
      }).catch(function () { smartIndexPromise = null; return []; });
    }
    return smartIndexPromise;
  }

  /**
   * Наши узлы в строке поиска обязаны переживать её пересборку.
   *
   * Замечание Александра 14.08 со снимками: «кнопка то появляется, то
   * пропадает». Так и было. Кнопку «Найти» и панель подсказок мы вешаем на
   * поле Tilda, а Tilda пересобирает панель на каждую догрузку каталога —
   * тринадцать раз за загрузку. Новое поле приходит без наших узлов, и до
   * следующего прохода apply (он отложен) кнопки нет: кадр с кнопкой, кадр
   * без.
   *
   * Стилями это не лечится — узел настоящий. Поэтому следим за самой
   * строкой отдельным наблюдателем: его обработчик вызывается до отрисовки,
   * в той же задаче, что и вставка. Значит первый же нарисованный кадр
   * будет с кнопкой.
   */
  var смотрительПоиска = null;
  var кореньПоиска = null;
  /** Действующий запрос: нужен, чтобы вернуть выдачу после пересборки. */
  var NGR_ЗАПРОС = '';
  var повторитьПоиск = null;
  /**
   * Сколько карточек было на странице, когда выдачу считали последний раз.
   *
   * Витрина растёт и во время поиска: с 17.08 запрос сам вызывает дорисовку
   * остальных товаров. Приехавшие карточки просеяны не были — без пересева
   * человек видел бы поверх своей находки весь каталог.
   */
  var карточекПриВыдаче = -1;
  var таймерПересева = null;
  /**
   * Что человек набрал, по нашей памяти, а не по полю Tilda.
   *
   * Поле — чужое и недолговечное: панель фильтров пересобирается на каждой
   * догрузке, и набранное исчезает вместе с узлом. Замер 17.08: к моменту
   * нажатия «Найти» поле было уже новым и пустым, и поиск отменял сам себя.
   * Поэтому запрос запоминаем на первом же нажатии клавиши.
   */
  var НАБРАНО = '';
  /*
   * Окошко для замеров: поиск живёт в замыканиях, и без него состояние видно
   * только по последствиям. Пригодилось 17.08, когда запрос терялся при
   * дорисовке витрины и версии приходилось проверять, а не угадывать.
   */
  window.NGR_СОСТОЯНИЕ_ПОИСКА = function () {
    var поле = document.querySelector('#rec2502703571 .js-catalog-filter-search');
    return {
      запрос: NGR_ЗАПРОС,
      набрано: НАБРАНО,
      вПоле: поле ? поле.value : null,
      полеЗаведено: !!(поле && поле.getAttribute('data-ngr-smart') === '1'),
      карточекПриВыдаче: карточекПриВыдаче,
      карточекСейчас: document.querySelectorAll('#rec2502703571 .js-product').length
    };
  };
  function следитьЗаПоиском() {
    // Панель могли пересобрать вместе с корнем — тогда наблюдатель повис в
    // пустоте и его надо поставить заново.
    if (смотрительПоиска && кореньПоиска && кореньПоиска.isConnected) return;
    if (смотрительПоиска) { смотрительПоиска.disconnect(); смотрительПоиска = null; }
    /*
     * Корень выбран замером 14.08. Tilda пересобирает не строку поиска, а
     * всю панель: на каждой из двенадцати догрузок каталога и
     * .t-catalog__filter, и .t-catalog__filter__controls-wrapper — уже
     * новые узлы. Наблюдатель на них умирал вместе с ними, и первая версия
     * этой правки не сработала: кнопки не было ни в одном из двенадцати
     * замеренных кадров.
     *
     * Переживает пересборку контейнер .js-catalog-parts-select-container —
     * именно он был целью всех двенадцати вставок. На нём и стоим, а
     * запасной вариант — сама запись каталога.
     */
    var корень = document.querySelector('#rec2502703571 .js-catalog-parts-select-container') ||
                 document.querySelector('#rec2502703571');
    if (!корень) return;   // записи ещё нет — попробуем на следующем проходе
    кореньПоиска = корень;
    смотрительПоиска = new MutationObserver(function () {
      /*
       * Заводить поиск заново нужно по признаку поля, а не кнопки.
       *
       * Tilda пересобирает панель и подменяет само поле, а наша кнопка при
       * этом может остаться на месте. Пока проверка смотрела только на
       * кнопку, обработчики продолжали висеть на выброшенном узле: человек
       * печатал в новом поле, а поиск этого не слышал (замер 17.08 — запрос
       * терялся ровно в тот момент, когда витрина дорисовывалась).
       */
      var живоеПоле = document.querySelector('#rec2502703571 .js-catalog-filter-search');
      if (!document.querySelector('.ngr-smart-search__go') ||
          (живоеПоле && живоеПоле.getAttribute('data-ngr-smart') !== '1')) initSmartSearch();
      // Панель пересобрали — вернём человеку то, что он искал или набирал.
      if (!NGR_ЗАПРОС && !НАБРАНО) return;
      var поле = document.querySelector('#rec2502703571 .js-catalog-filter-search');
      if (поле && !(поле.value || '').trim() && document.activeElement !== поле) {
        поле.value = NGR_ЗАПРОС || НАБРАНО;
        if (typeof повторитьПоиск === 'function') повторитьПоиск();
        return;
      }
      /*
       * Витрина доросла, а запрос жив — пересеваем.
       *
       * Иначе поверх найденного встаёт весь остальной каталог: карточки
       * приезжают без нашей пометки и показываются как подходящие, а плашка
       * продолжает обещать «нашли 2».
       */
      var сейчас = document.querySelectorAll('#rec2502703571 .js-product').length;
      if (сейчас !== карточекПриВыдаче && поле && (поле.value || '').trim()) {
        clearTimeout(таймерПересева);
        таймерПересева = setTimeout(function () {
          if (typeof повторитьПоиск === 'function') повторитьПоиск();
        }, 350);
      }
    });
    смотрительПоиска.observe(корень, { childList: true, subtree: true });
  }

  function initSmartSearch() {
    следитьЗаПоиском();
    var inp = searchInput();
    if (!inp) return;
    var existing = document.getElementById('ngr-smart-search-results');
    if (inp.getAttribute('data-ngr-smart') === '1' && existing && existing.isConnected) return;
    document.querySelectorAll('.ngr-smart-search__panel').forEach(function (p) { p.remove(); });
    inp.setAttribute('data-ngr-smart', '1');
    inp.setAttribute('autocomplete', 'off');
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-autocomplete', 'list');
    var host = inp.closest('.t-catalog__search-wrapper') || inp.parentNode;
    if (!host) return;
    host.classList.add('ngr-smart-search');
    var box = document.createElement('div');
    box.className = 'ngr-smart-search__panel';
    box.id = 'ngr-smart-search-results';
    box.hidden = true;
    box.setAttribute('role', 'listbox');
    host.appendChild(box);
    inp.setAttribute('aria-controls', box.id);
    inp.setAttribute('aria-expanded', 'false');
    var requestId = 0;
    var smartTimer = null;

    function hide() { box.hidden = true; inp.setAttribute('aria-expanded', 'false'); }
    function note(text) {
      box.innerHTML = '';
      var n = document.createElement('div');
      n.className = 'ngr-smart-search__note'; n.textContent = text;
      box.appendChild(n); box.hidden = false; inp.setAttribute('aria-expanded', 'true');
    }
    function draw(list) {
      box.innerHTML = '';
      if (!list.length) { note('Ничего не нашли. Попробуйте другое написание.'); return; }
      list.slice(0, 10).forEach(function (row) {
        var it = row.item;
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'ngr-smart-search__item'; b.setAttribute('role', 'option');
        var t = document.createElement('strong'); t.textContent = it.t;
        var m = document.createElement('span'); m.textContent = row.match + ' · Артикул ' + it.a;
        b.appendChild(t); b.appendChild(m);
        if (row.match === 'Описание' && it.d) {
          var d = document.createElement('small'); d.textContent = it.d; b.appendChild(d);
        }
        b.addEventListener('click', function () {
          clearSearchRestoreState();
          clearTimeout(smartTimer);
          requestId++;
          hide();
          openProduct(it.a);
        });
        box.appendChild(b);
      });
      box.hidden = false; inp.setAttribute('aria-expanded', 'true');
    }
    function run() {
      var raw = inp.value || '', q = smartNorm(raw);
      if (q.length < 2) { hide(); return; }
      /*
       * Подсказка не возвращается поверх готовой выдачи.
       *
       * Замечание Александра 14.08: «нажимаю найти — находит, но список
       * остаётся висеть; пропадает, только если щёлкнуть в стороне и снова
       * нажать найти». Причина в порядке событий: показ подсказки отложен на
       * 280 мс, и нажатие «Найти» могло прийтись в этот промежуток — сначала
       * мы прятали список, а следом срабатывал отложенный показ.
       *
       * Гасить один этот случай мало: любое повторное открытие поверх уже
       * показанной выдачи выглядит поломкой. Поэтому правило простое: пока
       * запрос не изменился, подсказка не возвращается.
       */
      if (NGR_ЗАПРОС && smartNorm(NGR_ЗАПРОС) === q) { hide(); return; }
      var mine = ++requestId;
      note('Ищем по названию и описанию…');
      loadSmartIndex().then(function (items) {
        if (mine !== requestId || !inp.isConnected || smartNorm(inp.value) !== q) return;
        if (!items.length) { hide(); return; } // native-поиск остаётся fallback
        var variants = [q], kb = keyboardVariant(q), tr = translitVariant(q);
        if (kb && kb !== q) variants.push(kb);
        if (tr && tr !== q && variants.indexOf(tr) < 0) variants.push(tr);
        var out = [];
        items.forEach(function (it) {
          var best = null;
          variants.forEach(function (v) { var r = rankSmart(it, v); if (r && (!best || r.score > best.score)) best = r; });
          if (best) out.push({ item: it, score: best.score, match: best.match });
        });
        out.sort(function (a, b) { return b.score - a.score || String(a.item.t).localeCompare(String(b.item.t), 'ru'); });
        draw(out);
      });
    }
    /**
     * Кнопка «Найти» и настоящая фильтрация выдачи.
     *
     * Замечание Александра 14.08: «не могу нажать кнопку, чтобы он не только
     * списком показывал, но и отфильтровал по поиску: в вебе могу, в мобилке
     * нет». Причин две, и обе наши.
     *
     * Первая: своей кнопки у поиска не было вовсе, а мобильные кнопки Tilda
     * («Поиск», «Фильтры») мы прячем — они дублировали наши. На компьютере
     * оставался Enter, на телефоне не оставалось ничего.
     *
     * Вторая: собственный поиск Tilda выдачу почти не сужает. Замер 14.08 на
     * 375 px по запросу «магний»: из 730 карточек скрылось 130, а 600
     * остались на месте. То есть даже нажатый Enter не давал того, чего ждёт
     * покупатель.
     *
     * Поэтому фильтруем сами, тем же указателем, по которому строится
     * подсказка: он ищет по названию, бренду, артикулу и описанию, знает
     * раскладку и латиницу. Карточку с указателем связываем по номеру
     * товара из ссылки — он же стоит на карточке в data-product-uid.
     */
    var кнопка = document.createElement('button');
    кнопка.type = 'button';
    кнопка.className = 'ngr-smart-search__go';
    кнопка.textContent = 'Найти';
    кнопка.setAttribute('aria-label', 'Показать найденные товары');
    host.appendChild(кнопка);
    // Чтобы на телефоне в углу клавиатуры была «Поиск», а не «Готово».
    inp.setAttribute('enterkeyhint', 'search');

    function номерТовара(it) {
      var m = /tproduct\/(\d+)/.exec(String(it && it.u || ''));
      return m ? m[1] : '';
    }
    function карточки() {
      return [].slice.call(document.querySelectorAll('#rec2502703571 .js-product'));
    }
    /**
     * Порядок карточек в сетке.
     *
     * Запоминаем исходный номер один раз: после поиска сетку надо вернуть
     * ровно как было, иначе каталог навсегда останется перетасованным.
     */
    function запомнитьПорядок(список) {
      список.forEach(function (c, i) {
        if (!c.hasAttribute('data-ngr-pos')) c.setAttribute('data-ngr-pos', String(i));
      });
    }
    function разложить(список, ключ) {
      var сетка = список[0] && список[0].parentNode;
      if (!сетка) return;
      var нужный = список.slice().sort(function (a, b) { return ключ(a) - ключ(b); });
      // Переставляем, только если порядок и правда другой: лишние appendChild
      // — это лишние перерисовки сетки и лишняя работа наблюдателям.
      var сейчас = [].slice.call(сетка.children).filter(function (c) {
        return c.classList && c.classList.contains('js-product');
      });
      var надо = нужный.some(function (c, i) { return сейчас[i] !== c; });
      if (!надо) return;
      нужный.forEach(function (c) { сетка.appendChild(c); });
    }

    function снятьВыдачу() {
      NGR_ЗАПРОС = '';
      карточекПриВыдаче = -1;
      clearTimeout(таймерПересева);
      var список = карточки();
      список.forEach(function (c) { c.classList.remove('ngr-search-off'); });
      разложить(список, function (c) { return Number(c.getAttribute('data-ngr-pos') || 0); });
      var p = document.getElementById('ngr-search-note');
      if (p) p.remove();
    }
    function плашка(запрос, сколько, совпало) {
      /*
       * Место плашки — прямо над сеткой товаров.
       *
       * Сперва я вставлял её сразу за строкой поиска, но строка лежит внутри
       * гибкой обёртки Tilda, и на телефоне плашка становилась её соседом и
       * уезжала ВЫШЕ самого поиска (видно на снимке 375 px 14.08). У сетки
       * такой беды нет: перед ней плашка читается в правильном порядке —
       * поиск, фильтры, «нашли столько-то», товары.
       */
      var первая = document.querySelector('#rec2502703571 .js-product');
      var сетка = первая && первая.parentNode;
      if (!сетка) return;
      var p = document.getElementById('ngr-search-note');
      if (!p || p.parentNode !== сетка) {
        if (p) p.remove();
        p = document.createElement('div');
        p.id = 'ngr-search-note';
        p.className = 'ngr-search-note';
      }
      // Кладём первым ребёнком самой сетки товаров.
      //
      // Соседом строки поиска плашку ставить нельзя: строка лежит в гибкой
      // обёртке Tilda, и на телефоне плашка уезжала выше поиска. Соседом
      // сетки — тоже: у сетки своя колонка в раскладке, и плашка всплывала
      // над фильтрами (замеры 14.08, 375 px). Внутри сетки место
      // однозначное: прямо над первой карточкой.
      if (сетка.firstChild !== p) сетка.insertBefore(p, сетка.firstChild);
      p.innerHTML = '';
      var t = document.createElement('span');
      // Совпадения могут быть, а на экране пусто: карточки с остатком ниже
      // порога MIN_STOCK мы не показываем. Врать «нашли 2», когда видно ноль,
      // нельзя — замечание Александра 14.08 по запросу «NOW L-Arginine».
      t.textContent = сколько
        ? ('Нашли ' + сколько + ' ' + словоТоваров(сколько) + ' по запросу «' + запрос + '»')
        : (совпало
            ? ('По запросу «' + запрос + '» есть ' + совпало + ' ' + словоТоваров(совпало) +
               ', но сейчас их нет в наличии')
            : ('По запросу «' + запрос + '» ничего не нашли'));
      var c = document.createElement('button');
      c.type = 'button'; c.className = 'ngr-search-note__off'; c.textContent = 'Показать все';
      c.addEventListener('click', function () {
        НАБРАНО = '';
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        снятьВыдачу();
        hide();
      });
      p.appendChild(t); p.appendChild(c);
    }
    function словоТоваров(n) {
      var d = n % 10, dd = n % 100;
      if (d === 1 && dd !== 11) return 'товар';
      if (d >= 2 && d <= 4 && (dd < 10 || dd >= 20)) return 'товара';
      return 'товаров';
    }

    function отфильтровать() {
      /*
       * Поле берём живое, а не то, что было при заводке: Tilda пересобирает
       * панель на каждой догрузке, и наш `inp` к этому времени может быть уже
       * выброшен из документа.
       */
      var поле = document.querySelector('#rec2502703571 .js-catalog-filter-search') || inp;
      var сырое = (поле.value || '').trim();
      /*
       * Пустое поле при живом запросе — не отмена поиска, а стёртый текст.
       *
       * Пересборка панели гасит набранное, и без этой проверки наш же пересев
       * читал пустоту и снимал выдачу: человек искал артикул, витрина
       * дорисовывалась и показывала весь каталог заново (замер 17.08).
       * Отмена — это когда человек стёр текст сам, и тогда курсор в поле.
       */
      if (!сырое && document.activeElement !== поле) {
        сырое = String(NGR_ЗАПРОС || НАБРАНО || '').trim();
        if (сырое) поле.value = сырое;
      }
      var q = smartNorm(сырое);
      // Запоминаем действующий запрос: панель и сетку Tilda пересобирает на
      // каждую догрузку, и без этого выдача молча пропадала бы вместе с
      // текстом в поле (замер 14.08 на 375 px: плашка и фильтрация исчезали
      // через несколько секунд после нажатия «Найти»).
      NGR_ЗАПРОС = сырое;
      // Гасим отложенную подсказку: иначе она всплывала поверх уже
      // показанной выдачи через 280 мс после нажатия «Найти».
      clearTimeout(smartTimer);
      requestId++;
      hide();
      if (q.length < 2) { снятьВыдачу(); return; }
      loadSmartIndex().then(function (items) {
        if (!items.length) return;   // без указателя выдачу не трогаем
        var variants = [q], kb = keyboardVariant(q), tr = translitVariant(q);
        if (kb && kb !== q) variants.push(kb);
        if (tr && tr !== q && variants.indexOf(tr) < 0) variants.push(tr);
        // Совпадение по названию весит больше, чем по описанию: иначе сверху
        // оказывались товары, где слово встречается только в тексте, и выдача
        // выглядела случайной.
        var годные = {};
        items.forEach(function (it) {
          var лучший = null;
          variants.forEach(function (v) {
            var r = rankSmart(it, v);
            if (r && (!лучший || r.score > лучший.score)) лучший = r;
          });
          if (!лучший) return;
          var u = номерТовара(it);
          if (u) годные[u] = лучший.score;
        });
        var список = карточки();
        карточекПриВыдаче = список.length;
        запомнитьПорядок(список);
        var видно = 0;
        список.forEach(function (c) {
          var u = c.getAttribute('data-product-uid') || c.getAttribute('data-product-gen-uid') || '';
          var вес = годные[u];
          var ok = вес !== undefined;
          c.classList.toggle('ngr-search-off', !ok);
          if (ok) видно++;
          // Совпавшие — по убыванию веса, остальные следом в прежнем порядке.
          c.setAttribute('data-ngr-hit', ok ? String(вес) : '');
        });
        разложить(список, function (c) {
          var s = c.getAttribute('data-ngr-hit');
          if (!s) return 1e9 + Number(c.getAttribute('data-ngr-pos') || 0);
          return -Number(s);
        });
        // Считаем не совпавшие, а видимые. Часть карточек прячет сама Tilda
        // (замер 14.08: 130 из 730), и обещать «нашли 120», когда на экране
        // 102, нельзя — человек пересчитает.
        var наЭкране = 0;
        список.forEach(function (c) {
          if (c.classList.contains('ngr-search-off')) return;
          if (c.offsetParent !== null) наЭкране++;
        });
        плашка(сырое, наЭкране, видно);
      });
    }

    // Даём наблюдателю за панелью способ повторить поиск после пересборки.
    повторитьПоиск = отфильтровать;
    кнопка.addEventListener('click', отфильтровать);
    // Enter на компьютере и «Поиск» на клавиатуре телефона — один и тот же путь.
    inp.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      отфильтровать();
    });
    inp.addEventListener('search', отфильтровать);

    inp.addEventListener('input', function () {
      clearTimeout(smartTimer);
      var сейчас = (inp.value || '').trim();
      if (сейчас) НАБРАНО = сейчас;
      /*
       * Стёрли запрос — возвращаем весь каталог, но только если стёр человек.
       *
       * Пустое поле бывает и не по его воле: Tilda подменяет узел на каждой
       * догрузке. Признак настоящей отмены — курсор в этом самом поле.
       */
      if (!сейчас && document.activeElement === inp) { НАБРАНО = ''; снятьВыдачу(); }
      smartTimer = setTimeout(run, 280);
    });
    inp.addEventListener('focus', function () { if (smartNorm(inp.value).length >= 2) run(); });
    // Ушли из поля — списка нет. Небольшая отсрочка нужна, чтобы успел
    // сработать щелчок по самой подсказке: он случается уже после blur.
    inp.addEventListener('blur', function () {
      setTimeout(function () {
        var внутри = document.activeElement && box.contains(document.activeElement);
        if (!внутри) hide();
      }, 180);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hide();
      if (e.key === 'ArrowDown' && !box.hidden) {
        var first = box.querySelector('button'); if (first) { e.preventDefault(); first.focus(); }
      }
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hide(); inp.focus(); return; }
      var buttons = [].slice.call(box.querySelectorAll('button'));
      var i = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && buttons[i + 1]) { e.preventDefault(); buttons[i + 1].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (buttons[i - 1] || inp).focus(); }
    });
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

  /** Кэш профиля нужен только для подписи; вход подтверждает живой токен. */
  function memberProfile() {
    try {
      var raw = localStorage.getItem('tilda_members_profile' + PROJECT);
      if (!raw) return null;
      var ts = Number(localStorage.getItem('tilda_members_profile' + PROJECT + '_timestamp') || 0);
      // Просроченный слепок не считаем входом: неделя — с запасом.
      if (ts && (Date.now() / 1000 - ts) > 7 * 24 * 3600) return null;
      var p = JSON.parse(raw);
      return (p && (p.name || p.login)) ? p : null;
    } catch (e) { return null; }
  }

  function member() {
    var tok = memberToken();
    var p = memberProfile();
    // ГОРЯЧИЙ ФИКС 10.08 (вечер). Серверное подтверждение /account/state не
    // проходит для настоящих токенов: Tilda отвечает отказом на проверку вне
    // браузера покупателя (журнал NG-2026-08-08-006), и требование серверного
    // подтверждения закрывало оформление заказа ВСЕМ вошедшим. Гейт снова
    // верит локальному профилю Tilda, как до 10.08. Серверная сверка остаётся
    // для профиля, избранного и истории — им строгость нужна, заказу нет.
    if (!tok && !p) return null;
    return {
      name: p ? String(p.name || p.login || '').trim() : '',
      login: p ? String(p.login || '') : '',
      phone: p ? String(p.phone || '') : '',
      hasToken: !!tok
    };
  }

  function fixAccountButton() {
    var a = document.querySelector('.ngr-account-link');
    if (!a) return;
    var m = member();
    var want = m ? 'in' : 'out';
    // В условие входит и выбранный значок: раньше кнопка перерисовывалась
    // только при смене входа или имени, и новый аватар в шапке не появлялся
    // до перезагрузки страницы (замечание Александра 08.08).
    var mine = profileSettings();
    var face = mine.photo ? ('photo' + String(mine.photo).length) : (mine.avatar || '');
    var key = want + (m && m.name ? m.name : '') + '|' + face;
    if (a.getAttribute('data-ngr-auth') === key) return;
    a.setAttribute('data-ngr-auth', key);

    if (!document.getElementById('ngr-account-css')) {
      var st = document.createElement('style');
      st.id = 'ngr-account-css';
      st.textContent =
        '.ngr-account-link.ngr-account--in{background:#fff5ec;border-color:#f0c9a3}' +
        '.ngr-account-link .ngr-ava{display:inline-flex!important;align-items:center!important;' +
        'justify-content:center!important;width:32px;height:32px;border-radius:50%;background:#ff7a1a;' +
        'color:#fff;font-size:14px;font-weight:700;margin-right:8px;flex:0 0 32px;' +
        // Буква стояла не по центру: у Tilda своя высота строки и отступы,
        // и они сдвигали её вниз-вбок (замечание Александра 16.08).
        'line-height:1!important;padding:0!important;text-align:center;letter-spacing:0;' +
        'background-size:cover;background-position:center;overflow:hidden;text-indent:0}' +
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
    // В шапке показываем выбранный аватар, а буква имени остаётся
    // запасным вариантом для тех, кто ничего не выбирал.
    var pic = mine.photo || (mine.avatar ? avaFile(mine.avatar) : '');
    a.innerHTML = '<span class="ngr-ava"' +
      (pic ? ' style="background-image:url(' + pic + ');background-size:cover;background-position:center;color:transparent"' : '') +
      '>' + letter + '</span>' +
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
      '.ngr-rate{display:flex;flex-wrap:wrap;align-items:center;gap:3px 6px;margin:6px 0 2px;' +
      'font-size:13px;line-height:1.2;color:#6b7280}' +
      '.ngr-rate b{color:#111;font-weight:700}' +
      // Число и слово «отзыва» держим вместе: на узкой карточке телефона
      // они разъезжались по разным строкам (замечание Александра 09.08).
      '.ngr-rate span{white-space:nowrap}' +
      '@media(max-width:560px){.ngr-rate{font-size:12px;gap:2px 5px}' +
      '.ngr-rate .ngr-star{font-size:13px}}' +
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
      '.ngr-rev__pics a{width:64px;height:64px}}' +
      // Своя форма отзыва
      '.ngr-revown{border:1px solid #ffd9b8;background:#fff8f1;border-radius:14px;' +
      'padding:16px 18px;margin:18px 0 4px}' +
      '.ngr-revown b{display:block;font-size:15px;color:#14171c;margin-bottom:4px}' +
      '.ngr-revown p{margin:0 0 12px;font-size:13px;color:#7a6551;line-height:1.5}' +
      '.ngr-revstars{display:flex;gap:6px;margin-bottom:12px}' +
      '.ngr-revstars button{width:38px;height:38px;padding:0;border:1px solid #e8d6c2;' +
      'background:#fff;border-radius:10px;font-size:19px;line-height:1;color:#d9dde2;cursor:pointer}' +
      '.ngr-revstars button[aria-checked="true"]{color:#ff9f1a;border-color:#ffbf70;background:#fff5e8}' +
      '.ngr-revown textarea{width:100%;box-sizing:border-box;min-height:88px;padding:11px 13px;' +
      'border:1px solid #e3e8ee;border-radius:11px;font:14px/1.5 inherit;color:#14171c;resize:vertical}' +
      '.ngr-revfiles{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}' +
      '.ngr-revfiles label{padding:9px 14px;border:1px dashed #e0b98f;border-radius:10px;' +
      'font-size:13px;font-weight:700;color:#b06c1e;cursor:pointer;background:#fff}' +
      '.ngr-revthumb{position:relative;width:56px;height:56px;border-radius:9px;overflow:hidden;' +
      'border:1px solid #eceff3}' +
      '.ngr-revthumb img{width:100%;height:100%;object-fit:cover;display:block}' +
      '.ngr-revthumb button{position:absolute;top:2px;right:2px;width:19px;height:19px;padding:0;' +
      'border:0;border-radius:50%;background:rgba(0,0,0,.6);color:#fff;font-size:12px;' +
      'line-height:19px;cursor:pointer}' +
      '.ngr-revsend{padding:12px 22px;border:0;border-radius:11px;background:#ff7a1a;color:#fff;' +
      'font-size:14px;font-weight:700;cursor:pointer}' +
      '.ngr-revsend[disabled]{background:#e6c7a8;cursor:default}' +
      '.ngr-revsaid{font-size:13px;color:#2f7d32;margin-left:10px}' +
      '.ngr-desclist{margin:0 0 14px;padding:0 0 0 20px;list-style:disc}' +
      '.ngr-desclist li{margin:0 0 6px;font-size:15px;line-height:1.6;color:#3d4550}' +
      '.ngr-cab__rev{margin-left:auto;flex:0 0 auto;padding:7px 13px;border-radius:9px;' +
      'background:#fff3e8;color:#c2560a;font-size:12px;font-weight:700;white-space:nowrap}' +
      '.ngr-revfail{font-size:13px;color:#c0392b;margin-top:8px}' +
      '.ngr-rev__own{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;' +
      'color:#b06c1e;background:#fff2e2;border-radius:5px;padding:2px 6px}';
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
      /*
       * На узкой карточке надпись не влезала в зелёную заливку и вылезала
       * за неё (снимок Александра с Samsung S24 Ultra, 17.08). Виноват
       * `white-space: nowrap`: строка «✓ Проверен: СГР есть» шире колонки
       * карточки, а фон рисуется по размеру плашки. На узких экранах
       * разрешаем перенос и слегка уменьшаем текст — плашка растёт вниз,
       * а не наружу.
       */
      '@media(max-width:960px){.ngr-sgr{white-space:normal;font-size:11px;line-height:1.25;' +
      'padding:5px 9px;max-width:100%;box-sizing:border-box;text-align:center;justify-content:center}}' +
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
      // Старая карточка Tilda успевала мелькнуть на полсекунды, пока мы её
      // закрывали — покупателю это неприятно (замечание Александра 08.08).
      // Теперь она не показывается вовсе, пока открыто наше окно.
      'html.ngr-own .t-popup:not(.ngr-pw){opacity:0!important;pointer-events:none!important;' +
      'visibility:hidden!important}' +
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
      /*
       * Окно товара уезжало вправо, и его приходилось листать по горизонтали
       * (замечание Александра 17.08 с телефона: название и кнопка «В корзину»
       * обрезаны справа).
       *
       * Причина не в тексте: полоска миниатюр — это шесть картинок по 62
       * точки, и её собственная минимальная ширина около 420. В сетке с
       * колонкой `1fr` такой ребёнок раздвигает колонку шире экрана, и
       * листать начинает вся страница, а не полоска. Лечится `minmax(0,1fr)`
       * и `min-width: 0` — тогда полоска сжимается и прокручивается сама,
       * как и задумано.
       */
      '.ngr-pd{grid-template-columns:minmax(0,1fr);gap:20px;padding:12px 16px 24px}' +
      '.ngr-pd__gal{flex-direction:column-reverse;min-width:0}' +
      '.ngr-pd__thumbs{flex-direction:row;flex:0 0 auto;overflow-x:auto;min-width:0;max-width:100%}' +
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
    document.documentElement.classList.remove('ngr-own');
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
      (d.left >= MIN_STOCK ? '<div class="ngr-pd__left">В наличии</div>' :
        '<div class="ngr-pd__left" style="color:#a11">Сейчас недоступен</div>') +
      '<button type="button" class="ngr-pd__buy"' + (d.left >= MIN_STOCK ? '' : ' disabled') + '>В корзину</button>' +
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
        // Разметку, приехавшую текстом, превращаем в списки и абзацы:
        // покупатель читал «84% белка</li><li>9403 мг» (замечание
        // Александра 16.08). На страницу всё равно кладём только текст.
        var блоки = разобратьОписание(lines.join('\n\n'));
        if (блоки && блоки.length) {
          блоки.forEach(function (б) {
            if (б.вид === 'список') {
              var ul = document.createElement('ul');
              ul.className = 'ngr-desclist';
              б.пункты.forEach(function (п) {
                var li = document.createElement('li'); li.textContent = п; ul.appendChild(li);
              });
              b1.appendChild(ul);
              return;
            }
            var pб = document.createElement('p'); pб.textContent = б.текст; b1.appendChild(pб);
          });
        } else {
          lines.join('\n\n').split('\n\n').forEach(function (p) {
            var el = document.createElement('p'); el.textContent = p; b1.appendChild(el);
          });
        }
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

    /*
     * Отзывы — тем же блоком, что в каталоге.
     *
     * Раньше блок строился только при отзывах Ozon и знал лишь их: свои
     * отзывы искались по артикулу вместо номера товара у Ozon и потому
     * не находились, а формы «оставить отзыв» здесь не было вовсе —
     * покупатель открывал купленный товар и написать не мог (замечание
     * Александра 16.08).
     */
    reviewCss();
    var rb = document.createElement('div');
    rb.className = 'ngr-revbox';
    body.querySelector('.ngr-pd__rev').appendChild(rb);
    var скуТовара = String(d.sku || d.art || '');
    Promise.all([нашиОтзывы(скуТовара), правоНаОтзывы()]).then(function (пара) {
      var можно = (пара[1] || []).filter(function (т) {
        return String(т.sku) === скуТовара || String(т.article || '') === String(d.art || '');
      })[0];
      renderReviews(rb, скуТовара, d.reviews || { n: 0, avg: 0, list: [] }, пара[0] || [], можно || null);
    });
  }

  /**
   * Гасим всплывающую карточку Tilda.
   *
   * Запретить ей открыться не выходит: она успевает раньше, и покупатель
   * видел сначала наше окно, а поверх — старое (замечание Александра 08.08).
   * Поэтому просто закрываем её, если открылась.
   */
  function killTildaPopup() {
    document.querySelectorAll('.t-popup_show').forEach(function (p) {
      if (p.closest && p.closest('.ngr-pw')) return;
      var x = p.querySelector('.t-popup__close, .t-popup__close-wrapper, .js-catalog-close-text');
      if (x) x.click(); else p.classList.remove('t-popup_show');
    });
  }

  function openProduct(art) {
    document.documentElement.classList.add('ngr-own');
    killTildaPopup();
    [80, 250, 500, 900, 1400].forEach(function (ms) { setTimeout(killTildaPopup, ms); });
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

  /** Открыть товар по названию — когда у позиции заказа нет артикула. */
  function openProductByName(name) {
    var w = prodWin();
    document.documentElement.classList.add('ngr-own');
    w.classList.add('ngr-pw_open');
    document.body.style.setProperty('overflow', 'hidden');
    w.querySelector('.ngr-pw__body').innerHTML =
      '<div style="padding:60px 30px;text-align:center;color:#8a919b">Ищем товар…</div>';
    fetch(API + '/catalog/find?q=' + encodeURIComponent(name.slice(0, 80)))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.art) throw new Error('нет');
        openProduct(j.art);
      })
      .catch(function () {
        w.querySelector('.ngr-pw__body').innerHTML =
          '<div style="padding:60px 30px;text-align:center;color:#a11">Этого товара уже нет в каталоге.</div>';
      });
  }

  /** Открыть товар по внутреннему номеру Tilda — так приходят товары в заказах. */
  function openProductByUid(uid) {
    var w = prodWin();
    document.documentElement.classList.add('ngr-own');
    w.classList.add('ngr-pw_open');
    document.body.style.setProperty('overflow', 'hidden');
    w.querySelector('.ngr-pw__body').innerHTML =
      '<div style="padding:60px 30px;text-align:center;color:#8a919b">Загружаем карточку…</div>';
    fetch(API + '/catalog/product?uid=' + encodeURIComponent(uid))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.error) throw new Error('нет данных');
        prodCache[j.art] = j;
        history.replaceState(null, '', location.pathname + '?ngprod=' + encodeURIComponent(j.art));
        renderProduct(j);
      })
      .catch(function () {
        w.querySelector('.ngr-pw__body').innerHTML =
          '<div style="padding:60px 30px;text-align:center;color:#a11">Этого товара уже нет в каталоге.</div>';
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
  /**
   * Каталог открывает наше окно. Перехватываем не только нажатие, но и
   * его начало: Tilda открывает свою карточку раньше, и у покупателя
   * сначала появлялось наше окно, а поверх — старое (замечание
   * Александра 08.08).
   */
  function shouldOpenOurWindow(el) {
    if (!el || !el.closest) return null;
    if (el.closest('.ngr-pw')) return null;              // внутри нашего окна
    var card = el.closest('.js-product');
    if (!card) return null;
    if (el.closest('.ngr-gal, .ngr-fav')) return null;   // точки галереи и сердечко
    if (el.closest('.ng2-brand-buy, [class*="cart"], [class*="quantity"], input, select')) return null;
    var txt = (el.textContent || '').trim();
    if (/^(в корзину|отменить|\+|−|-)$/i.test(txt)) return null;
    return article(card) || null;
  }

  ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      var art = shouldOpenOurWindow(e.target);
      if (!art) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (type === 'click') openProduct(art);
    }, true);
  });

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
    if (!open) {
      if (document.body.style.overflow === 'hidden') document.body.style.removeProperty('overflow');
      document.documentElement.classList.remove('ngr-own');
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
    var token = '';
    try { token = (window.t_cart__getMembersToken && t_cart__getMembersToken()) || ''; } catch (e) {}
    if (token) return token;
    // Это тот же официальный источник, который читает t_cart__getMauser()
    // внутри tilda-cart-1.1. На страницах, где helper ещё не объявлен,
    // профиль уже есть; токен всё равно обязательно проверяет Worker у Tilda.
    try {
      var mauser = JSON.parse(localStorage.getItem('tilda_members_profile' + TP) || 'null');
      token = mauser && mauser.token ? String(mauser.token) : '';
    } catch (e) {}
    if (token) return token;
    // Tilda может убрать helper после инициализации, но наш checkout уже
    // сохранил подтверждаемый токен в скрытом поле формы.
    var input = document.querySelector('input[name="ngmember"]');
    return input ? String(input.value || '') : '';
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
      // Выход отделён чертой и приглушён: это не раздел кабинета, а действие,
      // и попасть в него случайно вместо «Профиля» не должно быть легко.
      '.ngr-cab__nav b.ngr-cab__out{margin-top:14px;padding-top:14px;' +
      'border-top:1px solid #eceff3;border-radius:0;color:#8a919b}' +
      '.ngr-cab__nav b.ngr-cab__out:hover{background:transparent;color:#c0392b}' +
      '.ngr-cab h2{margin:0 0 16px;font-size:26px;font-weight:800;letter-spacing:-.6px;color:#14171c}' +
      '.ngr-cab__card{border:1px solid #e8ecf1;border-radius:16px;padding:18px;margin-bottom:14px}' +
      '.ngr-cab__row{display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:10px}' +
      '.ngr-cab__st{font-size:13px;font-weight:700;color:#1a8f4c}' +
      '.ngr-cab__sum{font-size:18px;font-weight:800;color:#14171c}' +
      // Состояние доставки — самое нужное в карточке заказа, поэтому у него
      // своя плашка, а не строчка мелким шрифтом среди прочего.
      '.ngr-cab__ship{margin-top:10px;padding:9px 12px;border-radius:10px;' +
      'background:#f1f6f2;color:#2f6b3f;font-size:13.5px;line-height:1.4}' +
      '.ngr-cab__ship_wait{background:#f5f7fa;color:#4a5464}' +
      '.ngr-cab__ship_off{background:#fdf3f2;color:#a8433c}' +
      '.ngr-cab__ship b{font-weight:700}' +
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
      '.ngr-cab__inp{width:100%;box-sizing:border-box;padding:11px 13px;border:1px solid #e3e8ee;' +
      'border-radius:10px;font-size:15px;color:#14171c;font-family:inherit;background:#fff}' +
      '.ngr-cab__inp:focus{outline:none;border-color:#4984c4}' +
      '.ngr-cab__ems{display:flex;gap:8px;flex-wrap:wrap}' +
      '.ngr-cab__em{width:42px;height:42px;border-radius:12px;border:1px solid #e3e8ee;background:#fff;' +
      'font-size:20px;cursor:pointer;line-height:1}' +
      '.ngr-cab__em:hover{background:#f5f7fa}' +
      '.ngr-cab__em.on{border-color:#4984c4;background:#eef4fb;box-shadow:0 0 0 2px rgba(73,132,196,.18)}' +
      '.ngr-cab__save{padding:11px 20px;border:0;border-radius:10px;background:#4984c4;color:#fff;' +
      'font-size:14px;font-weight:700;cursor:pointer}' +
      '.ngr-cab__save:hover{background:#3d74b0}' +
      '.ngr-cab__saved{margin-left:10px;font-size:13px;color:#1a8f4c;font-weight:700}' +
      '.ngr-cab__ref{display:flex;gap:8px;flex-wrap:wrap}' +
      '.ngr-cab__ref .ngr-cab__inp{flex:1;min-width:200px}' +
      '.ngr-cab__copy{padding:11px 16px;border:1px solid #e3e8ee;border-radius:10px;background:#fff;' +
      'font-size:14px;font-weight:600;color:#14171c;cursor:pointer;white-space:nowrap}' +
      '.ngr-cab__copy:hover{background:#f5f7fa}' +
      '.ngr-cab__hint{font-size:12.5px;color:#8a919b;line-height:1.5;margin-top:8px}' +
      '.ngr-cab__photo{display:flex;align-items:center;gap:12px;flex-wrap:wrap}' +
      /*
       * Блок фотографии — покрупнее и с понятной парой кнопок.
       *
       * Пожелание Александра 14.08: «это должно выглядеть современно,
       * красиво и понятно». Кружок был 64 px и стоял в одну строку с
       * кнопками, из-за чего читался как значок, а не как «вот так вас
       * увидят». Теперь 96 px с мягким кольцом, рядом столбик: главное
       * действие, второстепенное и подсказка про размер.
       */
      '.ngr-cab__prev{width:96px;height:96px;border-radius:50%;border:0;' +
      'box-shadow:0 0 0 1px #e3e8ee,0 6px 18px rgba(20,23,28,.08);' +
      'background:#f3f5f8 center/cover no-repeat;flex:0 0 96px}' +
      '.ngr-cab__photo{gap:16px!important;align-items:center!important}' +
      '.ngr-cab__photoacts{display:flex;flex-direction:column;gap:8px;align-items:flex-start;min-width:0}' +
      '.ngr-cab__photohint{font-size:12.5px;line-height:1.35;color:#8a919b}' +
      'label.ngr-cab__copy{display:inline-block}' +
      // Главное действие видно сразу, второстепенное — спокойное.
      '.ngr-cab__photoacts label.ngr-cab__copy{background:#4984c4;border-color:#4984c4;color:#fff}' +
      '.ngr-cab__photoacts label.ngr-cab__copy:hover{background:#3f76b1;border-color:#3f76b1}' +
      '@media(max-width:860px){' +
      '.ngr-cab{grid-template-columns:1fr;gap:16px;padding:12px 16px 26px}' +
      '.ngr-cab__side{position:static}' +
      '.ngr-cab__nav{display:flex;flex-wrap:wrap;gap:8px;padding-bottom:4px}' +
      '.ngr-cab__nav b{white-space:nowrap;padding:9px 13px;border:1px solid #e8ecf1;font-size:13.5px}' +
      '.ngr-cab h2{font-size:21px}}';
    document.head.appendChild(st);
  }

  var cabData = { profile: null, dash: null };

  /**
   * Фирменные аватары (60 штук, шесть наборов). Файлы лежат в статике
   * проекта, а в профиле хранится только устойчивый код вида nutrygo-31 —
   * не адрес картинки, чтобы переезд файлов не обнулял выбор
   * (требование Александра 09.08).
   */
  var AVA_URL = 'https://pikhtachoo.github.io/nutrygo-pvz/img/avatars/';
  var AVATARS = [["nutrygo-01","01-energy-woman.webp","Персонажи","Энергичная женщина"],["nutrygo-02","02-reliable-man.webp","Персонажи","Надёжный мужчина"],["nutrygo-03","03-smart-woman.webp","Персонажи","Умная и спокойная"],["nutrygo-04","04-active-mature-man.webp","Персонажи","Активный зрелый мужчина"],["nutrygo-05","05-creative-woman.webp","Персонажи","Творческая женщина"],["nutrygo-06","06-music-introvert.webp","Персонажи","Меломан-интроверт"],["nutrygo-07","07-balanced-person.webp","Персонажи","Спокойный характер"],["nutrygo-08","08-strong-woman.webp","Персонажи","Сильная женщина"],["nutrygo-09","09-focused-professional.webp","Персонажи","Собранный профессионал"],["nutrygo-10","10-wise-woman.webp","Персонажи","Мудрая женщина"],["nutrygo-11","11-fox.webp","Животные","Лис"],["nutrygo-12","12-dog.webp","Животные","Пёс"],["nutrygo-13","13-cat.webp","Животные","Кот"],["nutrygo-14","14-owl.webp","Животные","Сова"],["nutrygo-15","15-bear.webp","Животные","Медведь"],["nutrygo-16","16-squirrel.webp","Животные","Белка"],["nutrygo-17","17-rabbit.webp","Животные","Кролик"],["nutrygo-18","18-raccoon.webp","Животные","Енот"],["nutrygo-19","19-deer.webp","Животные","Олень"],["nutrygo-20","20-capybara.webp","Животные","Капибара"],["nutrygo-21","21-energy.webp","Абстракции","Энергия"],["nutrygo-22","22-calm.webp","Абстракции","Спокойствие"],["nutrygo-23","23-growth.webp","Абстракции","Рост"],["nutrygo-24","24-focus.webp","Абстракции","Фокус"],["nutrygo-25","25-freedom.webp","Абстракции","Свобода"],["nutrygo-26","26-balance.webp","Абстракции","Баланс"],["nutrygo-27","27-optimism.webp","Абстракции","Оптимизм"],["nutrygo-28","28-flow.webp","Абстракции","Поток"],["nutrygo-29","29-resilience.webp","Абстракции","Устойчивость"],["nutrygo-30","30-curiosity.webp","Абстракции","Любознательность"],["nutrygo-31","31-runner.webp","Спорт","Бег"],["nutrygo-32","32-strength-athlete.webp","Спорт","Силовой спорт"],["nutrygo-33","33-cyclist.webp","Спорт","Велоспорт"],["nutrygo-34","34-swimmer.webp","Спорт","Плавание"],["nutrygo-35","35-yoga.webp","Спорт","Йога"],["nutrygo-36","36-tennis.webp","Спорт","Теннис"],["nutrygo-37","37-boxer.webp","Спорт","Бокс"],["nutrygo-38","38-basketball.webp","Спорт","Баскетбол"],["nutrygo-39","39-hiker.webp","Спорт","Хайкинг"],["nutrygo-40","40-winter-athlete.webp","Спорт","Зимний спорт"],["nutrygo-41","41-family-doctor.webp","Медицина","Семейный врач"],["nutrygo-42","42-pediatric-doctor.webp","Медицина","Педиатр"],["nutrygo-43","43-cardiologist.webp","Медицина","Кардиолог"],["nutrygo-44","44-neurologist.webp","Медицина","Невролог"],["nutrygo-45","45-nutrition-doctor.webp","Медицина","Врач-нутрициолог"],["nutrygo-46","46-sports-doctor.webp","Медицина","Спортивный врач"],["nutrygo-47","47-pharmacist.webp","Медицина","Фармацевт"],["nutrygo-48","48-nurse-practitioner.webp","Медицина","Медицинский специалист"],["nutrygo-49","49-dentist.webp","Медицина","Стоматолог"],["nutrygo-50","50-laboratory-doctor.webp","Медицина","Врач лабораторной диагностики"],["nutrygo-51","51-music.webp","Интересы","Музыка"],["nutrygo-52","52-reading.webp","Интересы","Чтение"],["nutrygo-53","53-travel.webp","Интересы","Путешествия"],["nutrygo-54","54-photography.webp","Интересы","Фотография"],["nutrygo-55","55-art.webp","Интересы","Творчество"],["nutrygo-56","56-gaming.webp","Интересы","Игры"],["nutrygo-57","57-home.webp","Интересы","Дом и уют"],["nutrygo-58","58-morning-coffee.webp","Интересы","Утренний ритуал"],["nutrygo-59","59-explorer.webp","Интересы","Исследователь"],["nutrygo-60","60-future.webp","Интересы","Мечтатель"]];
  var AVA_CATS = ["Персонажи", "Животные", "Абстракции", "Спорт", "Медицина", "Интересы"];

  function avaFile(id) {
    for (var i = 0; i < AVATARS.length; i++) if (AVATARS[i][0] === id) return AVA_URL + AVATARS[i][1];
    return '';
  }
  function avaTitle(id) {
    for (var i = 0; i < AVATARS.length; i++) if (AVATARS[i][0] === id) return AVATARS[i][3];
    return '';
  }


  /* ---------- Выбор фирменного аватара ---------- */

  function avaCss() {
    if (document.getElementById('ngr-ava-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-ava-css';
    st.textContent =
      // Кружок аватара: круглая обрезка, синяя обводка у выбранного
      // и небольшая оранжевая отметка — фирменные цвета магазина.
      '.ngr-avc{width:72px;height:72px;padding:0;border:2px solid #e8ecf1;border-radius:50%;' +
      'background:#fbf9f6;overflow:hidden;cursor:pointer;position:relative;flex:0 0 auto;' +
      'transition:border-color .15s,transform .15s}' +
      '.ngr-avc img{width:100%;height:100%;object-fit:cover;display:block;border-radius:50%}' +
      '.ngr-avc:hover{transform:translateY(-1px);border-color:#c9d6e6}' +
      '.ngr-avc:focus-visible{outline:3px solid #4984c4;outline-offset:2px}' +
      '.ngr-avc.on{border-color:#4984c4;border-width:3px}' +
      '.ngr-avc.on::after{content:"";position:absolute;right:1px;bottom:1px;width:13px;height:13px;' +
      'border-radius:50%;background:#f0871f;border:2px solid #fff}' +
      '.ngr-avc__row{display:flex;flex-wrap:wrap;gap:12px;margin:4px 0 14px}' +
      '.ngr-avc__cap{font-size:12.5px;font-weight:700;color:#8a919b;text-transform:uppercase;' +
      'letter-spacing:.4px;margin:10px 0 2px}' +
      /*
       * Галерея аватаров: своя область с прокруткой, а не бесконечная лента.
       *
       * Шестьдесят кружков в шесть наборов растягивали профиль так, что
       * кнопка «Сохранить» уезжала за экран. Ограничиваем высоту, подписи
       * наборов прилипают к верху области — видно, где находишься.
       */
      '.ngr-avc__all{margin-top:4px;max-height:340px;overflow-y:auto;overflow-x:hidden;' +
      'padding:2px 4px 4px;border:1px solid #eef1f5;border-radius:14px;background:#fcfdfe;' +
      'overscroll-behavior:contain}' +
      '.ngr-avc__cap{position:sticky;top:0;z-index:2;background:#fcfdfe;padding:8px 2px 4px}' +
      // Выбранный виден без сомнений: кольцо и галочка.
      '.ngr-avc.on::after{content:"";position:absolute;right:2px;bottom:2px;width:20px;height:20px;' +
      'border-radius:50%;background:#4984c4 center/12px 12px no-repeat;' +
      'background-image:url("data:image/svg+xml;utf8,' +
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'><path d='M20 6L9 17l-5-5'/></svg>" +
      '");box-shadow:0 0 0 2px #fff}' +
      '@media(max-width:560px){.ngr-avc{width:62px;height:62px}.ngr-avc__row{gap:9px}}' +
      '.ngr-avc__more{padding:9px 16px;border:1px solid #e3e8ee;background:#fff;border-radius:10px;' +
      'font-size:14px;font-weight:600;color:#14171c;cursor:pointer;font-family:inherit}' +
      '.ngr-avc__more:hover{background:#f6f8fa}' +
      '.ngr-avc__more:focus-visible{outline:3px solid #4984c4;outline-offset:2px}';
    document.head.appendChild(st);
  }

  /**
   * Псевдоним и аватар хранятся в интеграторе, а не только в браузере:
   * иначе выбор терялся при смене устройства или чистке кэша (решение
   * Александра 08.08). Память браузера остаётся быстрым кэшем, чтобы
   * значок рисовался сразу, не дожидаясь ответа.
   */
  var accountSubject = '';
  var accountToken = '';
  var accountPromise = null;
  var accountVerified = false;

  function legacyProfileSettings() {
    try { return JSON.parse(localStorage.getItem('ngr_me') || '{}'); } catch (e) { return {}; }
  }
  function legacyFavorites() {
    try { return JSON.parse(localStorage.getItem('ngr_fav') || '[]'); } catch (e) { return []; }
  }
  function accountCacheKey(base) {
    return accountSubject ? base + ':' + accountSubject : base;
  }
  /**
   * Доказательство «это я» для воркера.
   *
   * Токен Tilda воркер подтвердить не может, поэтому прикладываем то же
   * доказательство, что и кабинет: адрес почты и собственные заказы из
   * панели Tilda. Их видит только тот, кто вошёл. Воркер сверяет со своими
   * записями и, если сходится, выдаёт подписанный пропуск — дальше шлём
   * его, и перебор заказов больше не нужен.
   */
  function предъявлениеДляВоркера() {
    var п = cabData.profile || memberProfile() || {};
    var почта = String(p_login(п)).trim().toLowerCase();
    var список = (cabData.dash && cabData.dash.last_orders) || [];
    if (почта.indexOf('@') < 1 || !список.length) return null;
    var заказы = список.map(function (o) {
      return {
        id: String(orderNo(o) || ''),
        /*
         * Суммы заказа. Tilda хранит их несколько, и они расходятся:
         * у заказа 1870945661 показано 738, а в оплату ушло 369. Сервер
         * сверяет с тем, что записано у нас, поэтому шлём все известные —
         * совпадения любой из них достаточно, чтобы узнать свой заказ.
         */
        amount: Number(o.amount_total || o.amount_final || o.amount || 0),
        amounts: [o.amount_total, o.amount_final, o.amount]
          .map(function (v) { return Math.round(Number(v) || 0); })
          .filter(function (v) { return v > 0; }),
        created: String(o.created || ''),
        // Состояние заказа у Tilda. Нашему серверу она его не отдаёт
        // (проверено 16.08: на живой токен возвращает ноль заказов),
        // поэтому передаём вместе с доказательством владения заказом.
        status: (o.status && typeof o.status === 'object')
          ? String(o.status.name || o.status.title || '')
          : String(o.status || o.delivery_status || o.state || '')
      };
    }).filter(function (o) { return o.id; });
    return заказы.length ? { email: почта, orders: заказы } : null;
  }
  function p_login(п) { return (п && (п.login || п.email)) || ''; }

  /*
   * Опознание покупателя вне кабинета.
   *
   * Токен Tilda наш сервер подтвердить не может (тупик от 10.08), поэтому
   * вместо него предъявляются собственные заказы покупателя. Их список
   * появлялся только при открытом кабинете — а на странице товара его нет,
   * и человек, честно купивший товар, получал отказ: «нажимаю в профиле,
   * а отзыв написать не могу» (замечание Александра 16.08). По той же
   * причине на устройстве, где кабинет не открывали, не переносились
   * псевдоним и аватар.
   *
   * Поэтому профиль и заказы подтягиваем сами — один раз за посещение и
   * только пока нет подписанного пропуска.
   */
  var предъявлениеЖдёт = null;
  function подготовитьПредъявление() {
    if (пропуск() || предъявлениеДляВоркера()) return Promise.resolve(true);
    if (!memberToken()) return Promise.resolve(false);
    if (предъявлениеЖдёт) return предъявлениеЖдёт;
    предъявлениеЖдёт = Promise.all([
      tildaPost('https://members.tildaapi.com/api/getprofile/').catch(function () { return null; }),
      tildaPost('https://store.tildaapi.com/api/orders/getdashboard/').catch(function () { return null; })
    ]).then(function (r) {
      if (!cabData.profile) cabData.profile = (r[0] && r[0].data) || memberProfile() || {};
      if (!cabData.dash) cabData.dash = (r[1] && r[1].data) || r[1] || null;
      return !!предъявлениеДляВоркера();
    }).catch(function () { return false; });
    return предъявлениеЖдёт;
  }

  function accountPost(action, data, requestToken, путь) {
    var token = requestToken || memberToken();
    if (!token) return Promise.reject(new Error('no member token'));
    var body = {};
    Object.keys(data || {}).forEach(function (k) { body[k] = data[k]; });
    body.action = action;
    body.token = token;
    var свой = пропуск();
    if (свой) body.pass = свой;
    var предъявление = предъявлениеДляВоркера();
    if (предъявление) body.claim = предъявление;
    return fetch(API + (путь || '/account/state'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) {
        // Отзыв может не приняться по понятной причине — «уже оставлен»,
        // «заказ ещё не получен». Её и показываем, а не номер ошибки.
        return r.json().catch(function () { return null; }).then(function (j) {
          var error = new Error((j && j.error) || ('account HTTP ' + r.status));
          error.status = r.status;
          throw error;
        });
      }
      return r.json().then(function (snapshot) {
        // Отзывы отвечают сами за себя, обёртка снимка им ни к чему.
        return (путь && путь !== '/account/state')
          ? snapshot
          : { snapshot: snapshot, token: token };
      });
    });
  }
  function applyAccountSnapshot(packet) {
    var j = packet && packet.snapshot;
    var requestToken = packet && packet.token;
    if (!requestToken || requestToken !== accountToken || requestToken !== memberToken()) return null;
    if (!j || !j.subject) return j;
    if (j.pass) запомнитьПропуск(j.pass);
    accountVerified = true;
    accountSubject = String(j.subject);
    var p = j.profile && typeof j.profile === 'object' ? j.profile : {};
    try {
      localStorage.setItem(accountCacheKey('ngr_me'), JSON.stringify(p));
      localStorage.setItem(accountCacheKey('ngr_fav'), JSON.stringify(Array.isArray(j.favorites) ? j.favorites : []));
    } catch (e) {}
    paintMe();
    fixAccountButton();
    paintFavoriteButtons();
    // Первый apply идёт до ответа Worker и временно закрывает оформление.
    // После подтверждения токена сразу пересчитываем gate, не ждём случайной DOM-мутации.
    fixAuthGate();
    return j;
  }
  function syncAccount(force) {
    var token = memberToken();
    if (!token) {
      accountSubject = '';
      accountToken = '';
      accountPromise = null;
      accountVerified = false;
      return Promise.resolve(null);
    }
    if (accountToken !== token) {
      accountToken = token;
      accountSubject = '';
      accountPromise = null;
      accountVerified = false;
    }
    if (accountPromise && !force) return accountPromise;
    var request = подготовитьПредъявление().then(function () {
      return accountPost('read', null, token);
    }).then(function (packet) {
      return applyAccountSnapshot(packet);
    }).catch(function (error) {
      if (accountToken === token && memberToken() === token) {
        if (error && error.status === 401) {
          accountVerified = false;
          // 401 — сервер осознанно не признал этот токен (Tilda не подтверждает
          // его вне браузера, см. журнал 12.08). Повторять тот же запрос на
          // каждую перерисовку страницы бессмысленно — консоль покупателя
          // заливало лавиной 401. Промис оставляем: повтор только по force
          // (открытие кабинета) или при смене токена.
          return null;
        }
        // Сетевые сбои — временные: разрешаем повтор при следующем проходе.
        accountPromise = null;
      }
      return null;
    });
    accountPromise = request;
    return request;
  }

  function pushProfile() {
    var cur = profileSettings();
    return accountPost('profile', {
      // Имя и телефон здесь не правятся, но передаём их обратно: запись
      // профиля на сервере полная, и молчание стёрло бы данные заказа.
      profile: {
        nick: cur.nick || '', avatar: cur.avatar || '', photo: cur.photo || '',
        name: cur.name || '', phone: cur.phone || ''
      }
    }).then(function (j) { return applyAccountSnapshot(j); });
  }

  function pullProfileOnce() {
    syncAccount(false);
  }

  function pullProfile() {
    return syncAccount(true);
  }

  /**
   * Где лежат личные настройки покупателя.
   *
   * Замечание Александра 14.08: «не сохраняет». Так и было, и вот почему.
   * Ключ хранения складывался из подтверждённого воркером признака входа, а
   * подтвердить вход воркер не может: Tilda отвечает ему отказом на проверку
   * токена (журнал NG-2026-08-08-006, тупик подтверждён и 13.08). Значит
   * признака нет, ключа нет, и запись отменялась ещё до попытки — человек
   * видел «Не удалось синхронизировать» и терял выбранный аватар.
   *
   * Разводим два вопроса, которые были смешаны в один. Хранить настройки на
   * этом устройстве можно всегда: это его же браузер и его же выбор. А вот
   * переносить их между устройствами — только когда воркер согласился, что
   * это тот самый человек. Ключ поэтому берём по возможности подтверждённый,
   * а если подтверждения нет — по адресу почты из профиля Tilda. Настройки
   * разных людей за одним браузером всё равно не смешаются.
   */
  function профильКлюч() {
    if (accountSubject && accountVerified && accountToken === memberToken()) {
      return accountCacheKey('ngr_me');
    }
    var m = memberProfile();
    var почта = m ? String(m.login || m.email || '').trim().toLowerCase() : '';
    return почта ? 'ngr_me:почта:' + почта : 'ngr_me';
  }
  function profileSettings() {
    try { return JSON.parse(localStorage.getItem(профильКлюч()) || '{}'); } catch (e) { return {}; }
  }
  function writeProfileSettings(cur) {
    try { localStorage.setItem(профильКлюч(), JSON.stringify(cur)); return true; } catch (e) { return false; }
  }
  function saveProfileSettings(v) {
    var cur = profileSettings();
    cur.nick = v.nick;
    if ('avatar' in v) cur.avatar = v.avatar;
    if ('emoji' in v) cur.emoji = v.emoji;
    writeProfileSettings(cur);
  }

  /**
   * Реферальная ссылка. Код выводим из почты — он один и тот же на любом
   * устройстве и ничего о покупателе не выдаёт.
   */
  function refCode(login) {
    var s = String(login || '').toLowerCase(), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 7);
  }
  function refLink(login) {
    return login ? 'https://nutry-go.ru/?ref=' + refCode(login) : 'Войдите, чтобы получить ссылку';
  }

  /** Значок и подпись покупателя — из его настроек, иначе из профиля. */
  function paintMe() {
    var p = cabData.profile || {};
    var me = profileSettings();
    var box = document.querySelector('.ngr-cab__me');
    if (!box) return;
    var nm = me.nick || p.name || 'Покупатель';
    var ava = box.querySelector('.ngr-cab__ava');
    var pic = me.photo || (me.avatar ? avaFile(me.avatar) : '');
    if (pic) {
      ava.textContent = '';
      ava.style.backgroundImage = 'url(' + pic + ')';
      ava.style.backgroundSize = 'cover';
      ava.style.backgroundPosition = 'center';
    } else {
      // Старым покупателям остаётся первая буква имени.
      ava.style.backgroundImage = '';
      ava.textContent = me.emoji || (nm.charAt(0) || 'П').toUpperCase();
    }
    box.querySelector('.ngr-cab__name').textContent = nm;
    box.querySelector('.ngr-cab__mail').textContent = p.login || '';
  }

  /**
   * Статус заказа. Tilda отдаёт его то строкой, то объектом, и по-английски —
   * покупателю показывались «delivery» и «cancelled» (замечание Александра
   * 08.08). Переводим на человеческий язык.
   */
  var STATUS_RU = {
    new: 'Новый', inprocess: 'В обработке', processing: 'В обработке',
    paid: 'Оплачен', payed: 'Оплачен', awaiting_payment: 'Ожидает оплаты',
    delivery: 'В доставке', shipped: 'Отправлен', done: 'Выполнен',
    completed: 'Выполнен', fulfilled: 'Выполнен', inprogress: 'В обработке',
    in_progress: 'В обработке', cancelled: 'Отменён', canceled: 'Отменён',
    refunded: 'Возврат', undeliverable: 'Доставка невозможна',
    delivery_created: 'Передан в Ozon Доставку', checkout_ok_dry_run: 'Доставка подтверждена',
    create_failed: 'Нужна помощь с доставкой', cancel_requested: 'Запрошена отмена',
    change_requested: 'Запрошено изменение'
  };

  function orderStatus(o) {
    // Состояние от Ozon старше всех остальных: наш собственный статус — это
    // лишь этап обработки («передан в доставку»), и он не меняется после
    // создания отправления. Замечание Александра 13.08: заказ уже получен, а
    // в карточке сверху висело «Передан в Ozon Доставку».
    if (o.shipment && o.shipment.text) {
      var т = String(o.shipment.text);
      return т.charAt(0).toUpperCase() + т.slice(1);
    }
    var s = o.delivery_status || o.status_name || o.status || o.state || '';
    if (s && typeof s === 'object') s = s.name || s.title || s.text || s.value || '';
    s = String(s || '');
    var key = s.toLowerCase().replace(/[\s-]/g, '_');
    if (STATUS_RU[key]) return STATUS_RU[key];
    /**
     * Незнакомый код покупателю не показываем.
     *
     * 14.08 в кабинете висело «fulfilled»: словарь его не знал, а запасной
     * ход отдавал строку как есть. Ровно так же 13.08 вылезло
     * «posting_in_carriage» от Ozon. Правило одно: латиница с
     * подчёркиваниями — служебный код, вместо него нейтральное «В
     * обработке», а сам код пишем в консоль, чтобы дописать словарь.
     *
     * Проверяем исходную строку, а не ключ: пробелы мы сами заменили на
     * подчёркивания, и по ключу живая надпись «Ожидает подтверждения»
     * выглядела бы кодом.
     */
    if (/^[a-z0-9_-]+$/i.test(s.trim())) {
      if (key) console.log('NGR: неизвестный статус заказа —', key);
      return 'В обработке';
    }
    return s || 'Оформлен';
  }

  /**
   * Номер заказа: у Tilda он лежит под разными именами.
   *
   * formsref добавлен 13.08: именно им пронумерованы заказы в панели
   * личного кабинета, а в списке его не было. Из-за этого номер выходил
   * пустым, наши заказы не находили пары в панели и не показывались вовсе.
   */
  function orderNo(o) {
    return String(o.formsref || o.id || o.orderid || o.order_id || o.number ||
      o.num || o.uid || o.paymentid || '').trim();
  }

  function orderItems(o) {
    var a = o.products || o.items || o.goods || o.positions || [];
    return Array.isArray(a) ? a : [];
  }

  /**
   * Наши заказы для кабинета.
   *
   * Токен Tilda воркер подтвердить не может: тот же токен работает из
   * браузера покупателя и не работает из сети Cloudflare (девять опытов,
   * журнал NG-2026-08-13-025). Поэтому вместе с токеном шлём предъявление —
   * почту из профиля и по каждому заказу номер, сумму и время создания,
   * взятые из панели самой Tilda. Всё это видно только вошедшему, и воркер
   * отдаёт заказ, лишь когда сходится всё сразу.
   *
   * Мера временная и слабее настоящей сессии; следующим шагом — свой вход
   * по коду на почту.
   */
  /**
   * Пропуск нашего собственного входа.
   *
   * Живёт в браузере покупателя. Внутри только почта и срок, подписанные на
   * стороне воркера, — секретов в нём нет, подделать нельзя.
   */
  var КЛЮЧ_ПРОПУСКА = 'ngr_pass_v1';
  /**
   * Пропуск выдаёт воркер после того, как мы предъявили ему собственные
   * заказы. Дальше он предъявляется вместо них — воркеру не приходится
   * перебирать хранилище на каждое чтение профиля.
   */
  function запомнитьПропуск(п) {
    if (!п) return;
    try { localStorage.setItem(КЛЮЧ_ПРОПУСКА, String(п)); } catch (e) {}
  }
  function пропуск() {
    try { return localStorage.getItem(КЛЮЧ_ПРОПУСКА) || ''; } catch (e) { return ''; }
  }
  function забытьПропуск() {
    try { localStorage.removeItem(КЛЮЧ_ПРОПУСКА); } catch (e) {}
  }

  /**
   * Заготовки вида {{form_login_title}} в окне входа.
   *
   * Замечание Александра 14.08: при открытии окна входа на секунду видны
   * служебные метки, потом подменяются настоящими надписями. Источник найти
   * не удалось: ни в нашем коде, ни в разметке страницы, ни в загруженных
   * файлах Tilda этих меток нет — окно строит скрипт, который подтягивается
   * уже по нажатию «Войти».
   *
   * Поэтому лечим не причину, а то, что видит человек: пока в окне остаются
   * метки, прячем его содержимое, и показываем, как только они подменились.
   * Через полторы секунды показываем в любом случае — оставить человека перед
   * пустым окном хуже, чем показать ему метки.
   *
   * Смотрим только на добавленные узлы, а не на весь документ: перебор всей
   * страницы на каждое изменение — это тот самый холостой обход, который мы
   * уже вычищали из каталога.
   */
  /**
   * Заготовки Tilda вида {{ключ}} и наши запасные надписи.
   *
   * Держим в общей области: этим пользуются и заслон в основном документе, и
   * починка внутри iframe с формой входа.
   */
  var МЕТКА = /\{\{[a-z0-9_]{3,40}\}\}/i;
  // Надписи взяты с той же формы, когда она успела загрузиться, — то есть
  // это ровно то, что Tilda и показывает, а не мой перевод.
  var НАШИ_НАДПИСИ = {
    form_login_title: 'Авторизация',
    form_login_field_email: 'Эл. почта',
    form_login_placeholder_email: 'Введите эл. почту',
    form_login_field_password: 'Пароль',
    form_login_placeholder_password: 'Введите свой пароль',
    form_login_submit: 'Войти',
    form_login_link_signup: 'Зарегистрироваться',
    form_login_link_rec: 'Восстановить пароль'
  };
  function подменитьЗнакомые(корень) {
    var замена = function (текст) {
      return String(текст)
        /*
         * Единица измерения на странице заказа.
         *
         * Замечание Александра 15.08 со снимком: в заказе №1868559242 вместо
         * «2 940 р./шт.» стояло «2 940 р./{{units_шт.}}», и рядом «1
         * {{units_шт.}}». Это заготовка самой Tilda: в ключе уже лежит нужное
         * слово, она просто не подставила его на этой странице. Подставляем
         * то, что в ключе и написано, — не выдумывая.
         */
        .replace(/\{\{units_([^}]{1,16})\}\}/gi, function (всё, ед) { return ед; })
        .replace(/\{\{([a-z0-9_]+)\}\}/gi, function (всё, ключ) {
          return Object.prototype.hasOwnProperty.call(НАШИ_НАДПИСИ, ключ)
            ? НАШИ_НАДПИСИ[ключ] : всё;
        });
    };
    // Только текстовые узлы и подсказки полей: разметку не трогаем.
    var ходок = document.createTreeWalker(корень, NodeFilter.SHOW_TEXT, null);
    var узел, правки = [];
    while ((узел = ходок.nextNode())) {
      if (МЕТКА.test(узел.nodeValue || '')) правки.push(узел);
    }
    правки.forEach(function (t) { t.nodeValue = замена(t.nodeValue); });
    корень.querySelectorAll('input[placeholder],textarea[placeholder]').forEach(function (п) {
      if (МЕТКА.test(п.placeholder || '')) п.placeholder = замена(п.placeholder);
    });
  }

  (function прячемЗаготовки() {
    function окно(el) {
      return (el.closest && el.closest('[class*=popup],[class*=modal],[class*=t-form]')) || null;
    }
    function присмотреть(узел) {
      if (!узел || узел.nodeType !== 1) return;
      if (!МЕТКА.test(узел.textContent || '')) return;
      var о = окно(узел) || узел;
      if (о.getAttribute('data-ngr-ждём') === '1') return;
      о.setAttribute('data-ngr-ждём', '1');
      var былаВидимость = о.style.visibility;
      о.style.visibility = 'hidden';
      var показать = function (подставить) {
        // Если Tilda так и не подставила надписи, ставим свои — но только те,
        // что я видел своими глазами на загрузившейся форме. Выдумывать
        // подписи к незнакомым ключам нельзя: лучше метка, чем неверное слово.
        if (подставить) подменитьЗнакомые(о);
        о.style.visibility = былаВидимость || '';
        о.removeAttribute('data-ngr-ждём');
        clearInterval(таймер);
        clearTimeout(предел);
      };
      var таймер = setInterval(function () {
        if (!МЕТКА.test(о.textContent || '')) показать();
      }, 60);
      var предел = setTimeout(function () { показать(true); }, 1500);
    }
    var наблюдатель = new MutationObserver(function (записи) {
      for (var i = 0; i < записи.length; i++) {
        var доб = записи[i].addedNodes;
        for (var k = 0; k < доб.length; k++) присмотреть(доб[k]);
      }
    });
    наблюдатель.observe(document.documentElement, { childList: true, subtree: true });
  })();

  function loadIntegratorOrders(token, profile, dash) {
    var свой = пропуск();
    // Без входа в Tilda, но со своим пропуском заказы всё равно показываем:
    // ради этого пропуск и заводился.
    if (!token && !свой) return Promise.resolve({ orders: [] });
    var тело = {};
    if (token) тело.token = token;
    if (свой) тело.pass = свой;
    var почта = (profile && (profile.login || profile.email)) || '';
    var список = (dash && dash.last_orders) || [];
    if (почта && список.length) {
      тело.claim = {
        email: String(почта),
        orders: список.map(function (o) {
          return {
            id: String(orderNo(o) || ''),
            amount: Number(o.amount_total || o.amount_final || o.amount || 0),
            created: String(o.created || '')
          };
        }).filter(function (o) { return o.id; })
      };
    }
    return fetch(API + '/orders/my', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      cache: 'no-store', body: JSON.stringify(тело)
    }).then(function (r) { if (!r.ok) throw new Error('orders HTTP ' + r.status); return r.json(); })
      .catch(function () { return { orders: [] }; });
  }

  function mergeOrderDashboard(nativeDash, integrator) {
    var dash = nativeDash && typeof nativeDash === 'object' ? nativeDash : {};
    var out = {};
    Object.keys(dash).forEach(function (k) { out[k] = dash[k]; });
    var orders = Array.isArray(dash.last_orders) ? dash.last_orders.slice() : [];
    var byId = {};
    orders.forEach(function (o, i) { var id = orderNo(o); if (id) byId[id] = i; });
    ((integrator && integrator.orders) || []).forEach(function (o) {
      var id = String(o.id || '').trim();
      var mapped = {
        id: id, date: o.at || '', amount: Number(o.amount) || 0,
        delivery_status: o.status || '', city: o.city || '', address: o.address || '',
        point: o.point || '', ozon_order: o.ozon_order || '',
        shipment: o.shipment || null,
        items: (o.items || []).map(function (it) {
          return { name: it.name || '', sku: it.sku || '', quantity: Number(it.qty) || 1, price: Number(it.price) || 0 };
        })
      };
      if (id && byId[id] !== undefined) {
        var current = orders[byId[id]];
        /*
         * Наш статус — это лишь этап обработки заказа. Если Tilda уже
         * сказала окончательное — «отменён» или «выполнен», — её слово
         * главнее: у отменённого заказа покупатель не должен видеть
         * «ожидает оплаты» (замечание Александра 16.08).
         */
        var ихСтатус = current.status || current.delivery_status || '';
        if (ихСтатус && typeof ихСтатус === 'object') ихСтатус = ихСтатус.name || ихСтатус.title || '';
        ихСтатус = String(ихСтатус).toLowerCase().replace(/[\s-]+/g, '_');
        var окончательные = ['cancelled', 'canceled', 'refunded', 'done', 'completed', 'fulfilled'];
        if (окончательные.indexOf(ихСтатус) < 0) {
          current.delivery_status = mapped.delivery_status || current.delivery_status || '';
        }
        current.city = current.city || mapped.city;
        current.address = current.address || mapped.address;
        current.ozon_order = current.ozon_order || mapped.ozon_order;
        // Состояние доставки всегда берём наше: Tilda о нём не знает, её
        // поле статуса ставит руками оператор (журнал NG-2026-08-13-021).
        if (mapped.shipment) current.shipment = mapped.shipment;
        if (!orderItems(current).length && mapped.items.length) current.items = mapped.items;
      } else {
        orders.push(mapped);
        if (id) byId[id] = orders.length - 1;
      }
    });
    orders.sort(function (a, b) {
      return String(b.date || b.created || b.datetime || '').localeCompare(String(a.date || a.created || a.datetime || ''));
    });
    /**
     * Заодно запоминаем покупателя для корзины.
     *
     * Просьба Александра 14.08: «профиль должен автоматически заполниться».
     * До этого корзина знала человека только на том устройстве, где он уже
     * оформлял заказ. Теперь достаточно один раз открыть кабинет: имя и
     * телефон приходят из его же последнего заказа, и следующая корзина
     * подставит их сама — на любом устройстве.
     *
     * Только пустые места: то, что человек вводил на этом устройстве сам,
     * ценнее прошлого заказа и не перетирается.
     */
    var свежий = ((integrator && integrator.orders) || []).slice().sort(function (a, b) {
      return String(b.at || '').localeCompare(String(a.at || ''));
    })[0];
    if (свежий && (свежий.name || свежий.phone)) {
      var уже = покупательИзПамяти();
      запомнитьПокупателя({
        name: уже.name || свежий.name || '',
        phone: уже.phone || цифрыТелефона(свежий.phone || '')
      });
    }
    out.last_orders = orders;
    return out;
  }

  /**
   * Метки {{form_login_...}} в окне входа сайта.
   *
   * Устройство окна выяснилось 14.08: #authModal — это подложка, внутри
   * которой лежит iframe со страницей /members/login того же домена. Форма
   * живёт в отдельном документе, поэтому прежний заслон от меток не
   * срабатывал вовсе — метки мелькают там, где он их не видел.
   *
   * Домен тот же, значит документ доступен, и метки чиним прямо в нём.
   * Свой вход по коду отсюда убран 14.08 («убирай наш костыль»): вход по
   * одноразовому коду делает сама Tilda, а её письма идут через наш SMTP.
   */
  (function нашВходВОкне() {
    function документОкна() {
      var ф = document.querySelector('#authModal iframe');
      if (!ф) return null;
      try { return ф.contentDocument || null; } catch (e) { return null; }
    }

    // Метки чиним там же, где они появляются, — внутри окна.
    function починитьМетки() {
      var д = документОкна();
      if (!д || !д.body) return;
      if (!МЕТКА.test(д.body.textContent || '')) return;
      подменитьЗнакомые(д.body);
    }

    /**
     * От нашего входа по коду здесь осталась только починка меток.
     *
     * Причина проста: наш код не делал человека вошедшим в Tilda — сессию
     * сайта выдаёт только она, метода для этого у её API нет. Рядом с родным
     * входом наш выглядел как второй вход, который «не сработал», хотя
     * работал: просто открывал не то.
     *
     * 14.08 в настройках личного кабинета включён штатный «Одноразовый код»,
     * и письма Tilda идут через наш SMTP. Свой механизм убран целиком — и из
     * страницы, и из воркера: ручки /auth/request и /auth/confirm отвечают
     * 410, потому что открытая отправка письма на любой адрес — это чужая
     * рассылка от нашего имени.
     */
    function присмотреть() { починитьМетки(); }

    var попыток = 0;
    var часы = setInterval(function () {
      присмотреть();
      if (++попыток > 40) clearInterval(часы);   // две минуты и хватит
    }, 3000);
    присмотреть();

    // И сразу, как только окно показывают или iframe перезагружается.
    new MutationObserver(function () {
      присмотреть();
      var ф = document.querySelector('#authModal iframe');
      if (ф && !ф.getAttribute('data-ngr-слежу')) {
        ф.setAttribute('data-ngr-слежу', '1');
        ф.addEventListener('load', function () { setTimeout(присмотреть, 300); });
      }
    }).observe(document.documentElement,
      { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'] });
  })();

  function cabSection(name) {
    var host = document.querySelector('.ngr-cab__main');
    if (!host) return;
    document.querySelectorAll('.ngr-cab__nav b').forEach(function (b) {
      // Переключаем только «on». Раньше здесь переписывался весь className, и
      // это сдирало с пункта «Выйти» его класс ngr-cab__out вместе с
      // оформлением — пункт был, но выглядел как обычный раздел.
      b.classList.toggle('on', b.getAttribute('data-s') === name);
    });
    var d = cabData.dash || {};
    var p = cabData.profile || {};

    if (name === 'orders') {
      var orders = d.last_orders || [];
      host.innerHTML = '<h2>Заказы</h2>' + (orders.length ? '' :
        (cabData.noToken
          ? '<div class="ngr-cab__empty">Заказы видны на страницах каталога.<br>' +
            '<a href="/" style="color:#2f6ba8">Перейти на главную</a></div>'
          : '<div class="ngr-cab__empty">Здесь появятся ваши заказы с сайта.<br>' +
            'Заказы, оформленные до входа в кабинет, сюда не попадают.</div>'));
      orders.forEach(function (o) {
        var c = document.createElement('div');
        c.className = 'ngr-cab__card';
        var no = orderNo(o);
        var items = orderItems(o);
        c.innerHTML = '<div class="ngr-cab__row"><div><b>' +
          (no ? 'Заказ № ' + no : 'Заказ') + '</b>' +
          '<div class="ngr-cab__mail">' + String(o.date || o.created || o.datetime || '').slice(0, 16) + '</div></div>' +
          '<div style="text-align:right"><div class="ngr-cab__sum">' + money(Number(o.amount) || 0) + '</div>' +
          '<div class="ngr-cab__st">' + (o.delivery_status ? 'Статус доставки: ' : '') + orderStatus(o) + '</div></div></div>';
        if (o.shipment && o.shipment.text) {
          var ship = document.createElement('div');
          var код = String(o.shipment.code || '');
          ship.className = 'ngr-cab__ship' +
            (код === 'posting_canceled' ? ' ngr-cab__ship_off' :
             (код === 'posting_delivered' || код === 'posting_received' ||
              код === 'posting_in_pickup_point') ? '' : ' ngr-cab__ship_wait');
          // Собираем узлами, а не строкой HTML: текст приходит от Ozon, и
          // подставлять чужую строку в разметку незачем.
          // Само состояние уже стоит в заголовке карточки, здесь — только
          // номер отправления, иначе одно и то же слово в карточке дважды.
          ship.appendChild(document.createTextNode('Доставка Ozon'));
          if (o.shipment.posting) {
            ship.appendChild(document.createTextNode(', отправление '));
            var жирным = document.createElement('b');
            жирным.textContent = String(o.shipment.posting);
            ship.appendChild(жирным);
          }
          c.appendChild(ship);
        }
        if (o.address) {
          var delivery = document.createElement('div');
          delivery.className = 'ngr-cab__hint';
          delivery.textContent = String(o.city || '') + (o.city && o.address ? ', ' : '') + String(o.address || '');
          c.appendChild(delivery);
        }
        if (items.length) {
          var box = document.createElement('div');
          box.className = 'ngr-cab__items';
          items.forEach(function (it) {
            var el = document.createElement('div');
            el.className = 'ngr-cab__it';
            el.innerHTML = '<i style="background-image:url(\'' + (it.img || it.image || '') + '\')"></i><span></span>';
            el.querySelector('span').textContent = (it.name || it.title || '') +
              (Number(it.quantity) > 1 ? ' ×' + it.quantity : '');
            // Открываем товар как получится: по артикулу, по внутреннему
            // номеру Tilda, а если их нет — по названию (в заказах Tilda
            // позиции приходят без опознавательных знаков).
            var sku = String(it.sku || it.article || '');
            var uid = String(it.uid || it.lid || it.externalid || it.product_id || '');
            var nm = String(it.name || it.title || '');
            el.style.cursor = 'pointer';
            el.title = 'Открыть товар';
            el.addEventListener('click', function () {
              if (sku) { openProduct(sku); return; }
              if (uid) { openProductByUid(uid); return; }
              if (nm.length > 3) openProductByName(nm);
            });
            box.appendChild(el);
          });
          c.appendChild(box);
        }
        host.appendChild(c);
      });
      var fullHistory = document.createElement('div');
      fullHistory.className = 'ngr-cab__hint';
      fullHistory.innerHTML = '<a href="/members/" style="color:#2f6ba8;font-weight:700">' +
        'Открыть полную историю заказов</a><br>' +
        'Здесь показаны последние заказы и актуальный статус доставки.';
      host.appendChild(fullHistory);
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
          el.innerHTML = '<i style="background-image:url(\'' + (b.img || '') + '\')"></i>' +
            '<span></span><b class="ngr-cab__rev" style="display:none"></b>';
          el.querySelector('span').textContent = b.name || '';
          el.style.cursor = 'pointer';
          el.addEventListener('click', function () {
            if (b.sku) openProduct(String(b.sku));
            else if (b.name) openProductByName(String(b.name));
          });
          box.appendChild(el);
        });
        host.appendChild(box);
        /*
         * Отзыв покупатель искал именно здесь — «нажимаю в профиле, а отзыв
         * написать не могу» (замечание Александра 16.08). Показываем метку
         * у тех товаров, на которые он вправе написать, и по ней открываем
         * карточку: форма живёт там, рядом с остальными отзывами.
         */
        правоНаОтзывы().then(function (можно) {
          if (!можно.length) return;
          buys.forEach(function (b, i) {
            var арт = String(b.sku || '');
            var подходит = можно.filter(function (м) {
              return String(м.article || '') === арт || String(м.sku || '') === арт;
            })[0];
            if (!подходит) return;
            var метка = box.children[i] && box.children[i].querySelector('.ngr-cab__rev');
            if (!метка) return;
            метка.textContent = 'Оставить отзыв';
            метка.style.display = '';
          });
        });
      }
      return;
    }

    if (name === 'fav') {
      var list = favList();
      var oldFav = legacyFavorites();
      var migrationDone = false;
      try { migrationDone = localStorage.getItem('ngr_fav_migrated:' + accountSubject) === '1'; } catch (e) {}
      var canMigrate = !!(accountSubject && oldFav.length && !migrationDone);
      host.innerHTML = '<h2>Избранное</h2>' +
        (canMigrate ? '<div class="ngr-cab__card ngr-cab__favmigrate">' +
          '<b>На этом устройстве найдено сохранённых товаров: ' + oldFav.length + '</b>' +
          '<div class="ngr-cab__hint">Перенести их именно в текущий аккаунт?</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
          '<button type="button" class="ngr-cab__save ngr-cab__favyes">Перенести</button>' +
          '<button type="button" class="ngr-cab__copy ngr-cab__favno">Не переносить</button></div></div>' : '') +
        (list.length ? '' :
          '<div class="ngr-cab__empty">Пока пусто. Нажмите ♡ на карточке товара, чтобы сохранить его сюда.</div>');
      var yes = host.querySelector('.ngr-cab__favyes');
      if (yes) yes.addEventListener('click', function () {
        yes.disabled = true;
        accountPost('merge', { favorites: oldFav }).then(function (packet) {
          if (!applyAccountSnapshot(packet)) throw new Error('account changed');
          try {
            localStorage.setItem('ngr_fav_migrated:' + accountSubject, '1');
            localStorage.removeItem('ngr_fav');
          } catch (e) {}
          cabSection('fav');
        }).catch(function () { yes.disabled = false; });
      });
      var no = host.querySelector('.ngr-cab__favno');
      if (no) no.addEventListener('click', function () {
        try { localStorage.setItem('ngr_fav_migrated:' + accountSubject, '1'); } catch (e) {}
        cabSection('fav');
      });
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

    // Профиль с персонализацией: покупатель выбирает значок и псевдоним,
    // рядом — его реферальная ссылка (запрос Александра 08.08).
    var me = profileSettings();
    var oldLocalPhoto = String((legacyProfileSettings() || {}).photo || '');
    /*
     * Имя и телефон: сперва то, что человек указал в настройках Tilda,
     * иначе — данные последнего заказа, сохранённые в профиле на сервере.
     * Раньше на этом месте стоял прочерк, хотя заказ уже был оформлен.
     */
    var имяДок = p.name || me.name || '';
    var телДок = p.phone || me.phone || '';
    var изЗаказа = (!p.name && !!me.name) || (!p.phone && !!me.phone);
    host.innerHTML = '<h2>Профиль</h2>' +
      '<div class="ngr-cab__card">' +
      '<div class="ngr-cab__field"><u>Как вас показывать</u>' +
      '<input class="ngr-cab__inp" id="ngrNick" maxlength="24" placeholder="' +
      (p.name || 'Псевдоним') + '" value="' + (me.nick || '') + '"></div>' +
      '<div class="ngr-cab__field"><u>Фотография</u>' +
      '<div class="ngr-cab__photo">' +
      // В кружке показываем то, что покупатель видит на сайте: свою
      // фотографию, а если её нет — выбранный аватар.
      '<div class="ngr-cab__prev"' +
      (me.photo ? ' style="background-image:url(' + me.photo + ')"'
        : (me.avatar ? ' style="background-image:url(' + avaFile(me.avatar) + ')"' : '')) + '></div>' +
      '<div class="ngr-cab__photoacts">' +
      '<label class="ngr-cab__copy">Загрузить фото' +
      '<input type="file" accept="image/*" id="ngrPhoto" style="display:none"></label>' +
      (me.photo ? '<button type="button" class="ngr-cab__copy ngr-cab__drop">Убрать фотографию</button>' : '') +
      (!me.photo && oldLocalPhoto
        ? '<button type="button" class="ngr-cab__copy ngr-cab__importphoto">Перенести фото с этого устройства</button>'
        : '') +
      '<div class="ngr-cab__photohint">Подойдёт любое изображение — мы уменьшим его до 160 точек ' +
      'прямо в браузере, на сервер оно не уходит.</div>' +
      '</div>' +
      '</div></div>' +
      '<div class="ngr-cab__field"><u>Или выберите аватар</u>' +
      '<div class="ngr-avc__all" role="radiogroup" aria-label="Аватар"></div></div>' +
      '<button type="button" class="ngr-cab__save">Сохранить</button>' +
      '<span class="ngr-cab__saved"></span>' +
      '</div>' +
      '<div class="ngr-cab__card">' +
      '<div class="ngr-cab__field"><u>Ваша реферальная ссылка</u>' +
      '<div class="ngr-cab__ref"><input class="ngr-cab__inp" id="ngrRef" readonly value="' +
      refLink(p.login || '') + '"><button type="button" class="ngr-cab__copy ngr-cab__copyref">Скопировать</button></div></div>' +
      '<div class="ngr-cab__hint">Поделитесь ссылкой — мы увидим, что покупатель пришёл от вас.</div>' +
      '</div>' +
      '<div class="ngr-cab__card">' +
      '<div class="ngr-cab__field"><u>Имя в документах</u><b>' + (имяДок || '—') + '</b></div>' +
      '<div class="ngr-cab__field"><u>Электронная почта</u><b>' + (p.login || '—') + '</b></div>' +
      '<div class="ngr-cab__field"><u>Телефон</u><b>' +
      (телДок ? телефонДляГлаз(телДок) : '—') + '</b></div>' +
      (изЗаказа
        ? '<div class="ngr-cab__hint">Взято из вашего последнего заказа — ' +
          'в следующий раз подставим сами.</div>'
        : '') +
      '<div class="ngr-cab__hint">Эти данные используются для заказов. Изменить их и пароль можно в ' +
      '<a href="/members/profile/" style="color:#2f6ba8">настройках профиля</a>.</div>' +
      '</div>';

    avaCss();
    var chosen = me.avatar || '';

    var avaПоказано = 0;
    /** Догрузка остальных аватаров: наблюдаем сам список, а не страницу. */
    function догрузитьАватары(список) {
      var ждут = [].slice.call(список.querySelectorAll('img[data-src]'));
      if (!ждут.length) return;
      var прокрутка = список;
      while (прокрутка && прокрутка !== document.body) {
        var o = getComputedStyle(прокрутка).overflowY;
        if (o === 'auto' || o === 'scroll') break;
        прокрутка = прокрутка.parentElement;
      }
      var включить = function (im) {
        var u = im.getAttribute('data-src');
        if (!u) return;
        im.removeAttribute('data-src');
        im.src = u;
      };
      if (!('IntersectionObserver' in window)) { ждут.forEach(включить); return; }
      var сторож = new IntersectionObserver(function (записи) {
        записи.forEach(function (з) {
          if (!з.isIntersecting) return;
          включить(з.target);
          сторож.unobserve(з.target);
        });
      }, { root: (прокрутка && прокрутка !== document.body) ? прокрутка : null, rootMargin: '300px' });
      ждут.forEach(function (im) { сторож.observe(im); });
    }

    // Кружок аватара. Подписи в ряду нет — название читается наведением
    // и озвучивается голосовым доступом.
    function avaCard(a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ngr-avc' + (a[0] === chosen ? ' on' : '');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', a[0] === chosen ? 'true' : 'false');
      b.setAttribute('aria-label', a[3]);
      b.title = a[3];
      b.setAttribute('data-id', a[0]);
      var im = document.createElement('img');
      /*
       * Аватары грузим сами, без loading="lazy".
       *
       * Замечание Александра 14.08: «аватары не прогружаются в личном
       * кабинете». Проверка на его же странице: все шестьдесят картинок
       * висят с complete=false, naturalWidth=0, и **ни одного сетевого
       * запроса** — при том, что первая из них занимает 68×68 прямо в
       * видимой части экрана, а файлы отдаются с кодом 200.
       *
       * Дело в самом lazy: кабинет — это наложение поверх страницы со своей
       * прокруткой, и браузер не считает нужным грузить картинки внутри
       * него. Проверено там же: стоит поставить eager и перезадать адрес,
       * как все шесть подопытных загружаются (512×512).
       *
       * Поэтому откладываем загрузку сами и по своим правилам: первые
       * восемнадцать (три ряда, которые видно сразу) грузятся немедленно,
       * остальные — когда доедут до края списка. Наблюдатель привязан к
       * самому списку, а не к странице, — в этом и была разница.
       */
      im.decoding = 'async';
      im.alt = '';
      if (avaПоказано < 18) { im.src = AVA_URL + a[1]; }
      else { im.setAttribute('data-src', AVA_URL + a[1]); }
      avaПоказано++;
      b.appendChild(im);
      b.addEventListener('click', function () { pickAva(a[0]); });
      return b;
    }

    function pickAva(id) {
      chosen = id;
      document.querySelectorAll('.ngr-avc').forEach(function (x) {
        var on = x.getAttribute('data-id') === id;
        x.classList.toggle('on', on);
        x.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      // Аватар применяется сразу, как и загруженная фотография. Раньше выбор
      // ждал нажатия «Сохранить», и по нажатию ничего видимого не менялось
      // (замечание Александра 09.08).
      var cur = profileSettings();
      cur.avatar = id;
      cur.emoji = '';
      delete cur.photo;
      var ok = writeProfileSettings(cur);
      var note = host.querySelector('.ngr-cab__saved');
      if (note) note.textContent = ok ? 'Сохраняем…' : 'Браузер не дал сохранить выбор';
      var prev = host.querySelector('.ngr-cab__prev');
      if (prev) {
        prev.style.backgroundImage = 'url(' + avaFile(id) + ')';
        prev.style.backgroundSize = 'cover';
      }
      paintMe();
      fixAccountButton();
      // Сохранено на этом устройстве — уже успех, и об этом надо сказать
      // именно так. Перенос на другие устройства зависит от подтверждения
      // входа воркером, а его Tilda не даёт; называть это «не удалось» —
      // значит пугать человека там, где его выбор на самом деле сохранён.
      if (ok && note) note.textContent = '✓ Аватар сохранён';
      if (ok) pushProfile().then(function () {
        if (note) note.textContent = '✓ Аватар сохранён на всех устройствах';
      }).catch(function () {
        if (note) note.textContent = '✓ Аватар сохранён на этом устройстве';
      });
      drawRow();
    }

    // Все шестьдесят видны сразу, набор за набором: отдельная кнопка
    // и окно только мешали (решение Александра 08.08).
    var row = host.querySelector('.ngr-avc__all');
    function drawRow() {
      row.innerHTML = '';
      avaПоказано = 0;
      AVA_CATS.forEach(function (c) {
        var head = document.createElement('div');
        head.className = 'ngr-avc__cap';
        head.textContent = c;
        row.appendChild(head);
        var line = document.createElement('div');
        line.className = 'ngr-avc__row';
        AVATARS.forEach(function (a) { if (a[2] === c) line.appendChild(avaCard(a)); });
        row.appendChild(line);
      });
      догрузитьАватары(row);
    }
    drawRow();

    // Загрузка фотографии: уменьшаем до 160 точек прямо в браузере и храним
    // там же. Так фотография не уходит на сторону и не весит лишнего.
    var inp = host.querySelector('#ngrPhoto');
    if (inp) inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { alert('Фотография слишком большая, до 8 МБ.'); return; }
      var rd = new FileReader();
      rd.onload = function () {
        var im = new Image();
        im.onload = function () {
          var s = 160, cv = document.createElement('canvas');
          cv.width = s; cv.height = s;
          var side = Math.min(im.width, im.height);
          cv.getContext('2d').drawImage(im, (im.width - side) / 2, (im.height - side) / 2,
            side, side, 0, 0, s, s);
          var data = cv.toDataURL('image/jpeg', 0.82);
          var cur = profileSettings(); cur.photo = data;
          if (!writeProfileSettings(cur)) {
            alert('Не удалось сохранить фотографию в этом браузере.'); return;
          }
          host.querySelector('.ngr-cab__prev').style.backgroundImage = 'url(' + data + ')';
          paintMe(); fixAccountButton();
          var note = host.querySelector('.ngr-cab__saved');
          if (note) note.textContent = 'Сохраняем фото…';
          pushProfile().then(function () {
            try { localStorage.removeItem('ngr_me'); } catch (e) {}
            if (note) note.textContent = '✓ Фото сохранено на всех устройствах';
          }).catch(function () {
            if (note) note.textContent = 'Фото осталось на этом устройстве; синхронизация не удалась.';
          });
        };
        im.src = rd.result;
      };
      rd.readAsDataURL(f);
    });

    var importPhoto = host.querySelector('.ngr-cab__importphoto');
    if (importPhoto) importPhoto.addEventListener('click', function () {
      var cur = profileSettings();
      cur.photo = oldLocalPhoto;
      if (!writeProfileSettings(cur)) return;
      importPhoto.disabled = true;
      var note = host.querySelector('.ngr-cab__saved');
      if (note) note.textContent = 'Переносим фото…';
      pushProfile().then(function () {
        try { localStorage.removeItem('ngr_me'); } catch (e) {}
        cabSection('profile');
      }).catch(function () {
        importPhoto.disabled = false;
        if (note) note.textContent = 'Не удалось перенести фото. Попробуйте ещё раз.';
      });
    });

    var drop = host.querySelector('.ngr-cab__drop');
    if (drop) drop.addEventListener('click', function () {
      var cur = profileSettings(); delete cur.photo;
      writeProfileSettings(cur);
      host.querySelector('.ngr-cab__prev').style.backgroundImage = '';
      drop.parentNode.removeChild(drop);
      paintMe(); fixAccountButton();
      pushProfile().catch(function () {});
    });

    host.querySelector('.ngr-cab__save').addEventListener('click', function () {
      var nick = (host.querySelector('#ngrNick').value || '').trim();
      saveProfileSettings({ nick: nick, avatar: chosen, emoji: '' });
      // Запись в память браузера может не пройти молча — перечитываем
      // сохранённое и говорим покупателю правду.
      var now = profileSettings();
      var зам = host.querySelector('.ngr-cab__saved');
      var сохранилось = (now.nick === nick && now.avatar === chosen);
      зам.textContent = сохранилось ? '✓ Сохранено' : 'Браузер не дал сохранить';
      if (!сохранилось) return;
      paintMe(); fixAccountButton();
      pushProfile().then(function () {
        зам.textContent = '✓ Сохранено на всех устройствах';
        paintMe(); fixAccountButton();
      }).catch(function () {
        зам.textContent = '✓ Сохранено на этом устройстве';
      });
    });

    // Раньше подпись искалась по общему классу и доставалась первой кнопке —
    // загрузке фотографии: вместо «Загрузить фото» там оказывалось
    // «Скопировать» (замечание Александра 09.08).
    var copyRef = host.querySelector('.ngr-cab__copyref');
    if (copyRef) {
      copyRef.addEventListener('click', function () {
        var f = host.querySelector('#ngrRef');
        f.select();
        try { document.execCommand('copy'); } catch (e) {}
        copyRef.textContent = '✓ Скопировано';
        setTimeout(function () { copyRef.textContent = 'Скопировать'; }, 1800);
      });
    }
  }

  /**
   * Выход из кабинета.
   *
   * Выходим руками Tilda: tma__userbar__sendLogout — её же функция, ту самую
   * кнопку «Выйти» показывает Tilda в форме заказа. Своими силами сессию не
   * гасим: чем гасить, знает только Tilda, а расходиться с ней в этом вопросе
   * опасно — можно оставить полусостояние, когда профиль стёрт, а сессия жива.
   *
   * Локальный слепок профиля стираем сами: по нему ngr-stock решает, вошёл ли
   * покупатель, и без этого страница до перезагрузки считала бы, что он всё
   * ещё внутри. Ключ проекта не зашиваем — снимаем все tilda_members_profile*.
   */
  function cabLogout(btn) {
    if (btn) { btn.textContent = 'Выходим…'; btn.style.pointerEvents = 'none'; }
    var завершить = function () {
      try {
        var убрать = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf('tilda_members_profile') === 0) убрать.push(k);
        }
        убрать.forEach(function (k) { localStorage.removeItem(k); });
        // И наш пропуск. Его никто не стирал: выйдя из Tilda, человек
        // оставался «своим» для воркера, и кабинет по старому пропуску
        // показал бы его заказы следующему, кто сядет за этот браузер.
        забытьПропуск();
      } catch (e) {}
      location.reload();
    };
    try {
      if (typeof window.tma__userbar__sendLogout === 'function') {
        var r = window.tma__userbar__sendLogout();
        // Функция Tilda ничего не возвращает и сама не перезагружает страницу,
        // поэтому даём ей секунду на свой запрос и уходим сами.
        if (r && typeof r.then === 'function') { r.then(завершить, завершить); return; }
        setTimeout(завершить, 1000);
        return;
      }
    } catch (e) {}
    завершить();
  }

  function openCabinet() {
    var me = member();
    if (!me) { location.href = '#openmembersbar'; return; }
    document.documentElement.classList.add('ngr-own');
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
      '<b data-s="profile">Профиль</b>' +
      // Выхода в кабинете не было вовсе: сменить аккаунт можно было только
      // через кнопку Tilda в форме заказа, а её видно лишь при оформлении
      // (замечание Александра 13.08).
      '<b data-s="logout" class="ngr-cab__out">Выйти</b>' +
      '</div></div><div class="ngr-cab__main"><div class="ngr-cab__empty">Загружаем…</div></div></div>';

    body.querySelectorAll('.ngr-cab__nav b').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-s') === 'logout') { cabLogout(b); return; }
        cabSection(b.getAttribute('data-s'));
      });
    });

    var token = memberToken();
    var noToken = !token;
    Promise.all([
      noToken ? Promise.resolve(null) : tildaPost('https://members.tildaapi.com/api/getprofile/').catch(function () { return null; }),
      noToken ? Promise.resolve(null) : tildaPost('https://store.tildaapi.com/api/orders/getdashboard/').catch(function () { return null; }),
      noToken ? Promise.resolve(null) : syncAccount(false)
    ]).then(function (первые) {
      // За нашими заказами идём после панели: из неё берётся предъявление.
      var проф = (первые[0] && первые[0].data) || null;
      var панель = (первые[1] && первые[1].data) || первые[1] || null;
      return loadIntegratorOrders(token, проф, панель)
        .then(function (наши) { return первые.concat([наши]); });
    }).then(function (res) {
      // На страницах без корзины Tilda не выдаёт токен — показываем то,
      // что знаем из профиля, и честно говорим про заказы.
      cabData.profile = (res[0] && res[0].data) || memberProfile() || {};
      // Tilda встречается в двух совместимых форматах: dashboard в корне либо в data.
      // Нормализуем только оболочку; владельцем статуса заказа остаётся сама Tilda.
      cabData.dash = mergeOrderDashboard((res[1] && res[1].data) || res[1] || {}, res[3]);
      cabData.noToken = noToken;
      paintMe();
      cabSection('orders');
    });
  }

  window.NGR_OPEN_CABINET = openCabinet;

  /* ---------- Избранное ---------- */

  /** Гость хранит избранное локально; аккаунт — в проверенном Worker state. */
  function verifiedAccountToken() {
    var token = memberToken();
    return token && accountVerified && accountSubject && accountToken === token ? token : '';
  }
  function favList() {
    var key = verifiedAccountToken() ? accountCacheKey('ngr_fav') : 'ngr_fav:guest:v1';
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
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
  function paintFavoriteButtons() {
    document.querySelectorAll('.js-product, .ngr-sc').forEach(function (c) {
      var art = c.classList.contains('ngr-sc') ? c.getAttribute('data-art') : article(c);
      var b = c.querySelector('.ngr-fav');
      if (!art || !b) return;
      var on = favHas(art);
      b.className = 'ngr-fav' + (on ? ' on' : '');
      b.textContent = on ? '♥' : '♡';
    });
  }
  function favToggle(a) {
    var l = favList(), i = l.indexOf(String(a));
    if (i > -1) l.splice(i, 1); else l.push(String(a));
    var on = i < 0;
    var requestToken = verifiedAccountToken();
    var intentToken = memberToken();
    var key = requestToken ? accountCacheKey('ngr_fav') : 'ngr_fav:guest:v1';
    try { localStorage.setItem(key, JSON.stringify(l)); } catch (e) {}
    if (intentToken) {
      var send = function () {
        // Клик относится к тому аккаунту, который был открыт в момент клика.
        // После logout/switch не переносим это действие в новую сессию.
        if (memberToken() !== intentToken) return Promise.resolve(null);
        return accountPost('favorite', { id: String(a), on: on }, intentToken)
          .then(function (packet) { applyAccountSnapshot(packet); });
      };
      if (requestToken) send().catch(function () {});
      else syncAccount(false).then(function () { return send(); }).catch(function () {});
    }
    return on;
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
      /*
       * Цена на полке не переносится по строкам.
       *
       * Замечание Александра 15.08 со снимком «Скидки недели»: вместо
       * «1 373 ₽» в плашке стояло три строки — «1», «373», «₽». Замер на
       * 375 px: ширина плашки 49 px при высоте 65 — то есть колонка ужалась
       * до ширины самого длинного слова, а слова здесь по одному знаку.
       * Запрещаем перенос и не даём колонке сжиматься меньше содержимого.
       */
      '.ngr-sc__now{background:#4984c4;color:#fff;font-size:18px;font-weight:800;padding:5px 11px;' +
      'border-radius:10px;white-space:nowrap;flex:0 0 auto}' +
      '.ngr-sc__old{color:#a6adb6;font-size:14px;font-weight:600;text-decoration:line-through;' +
      'white-space:nowrap;flex:0 0 auto}' +
      /*
       * Число колонок на полке — с тем же весом, что и у основного правила.
       *
       * Замечание Александра 15.08: «Скидки недели — то же самое с вёрсткой».
       * И правда: у базового правила стоял !important, а у медиазапросов нет,
       * поэтому четыре колонки побеждали на любой ширине. Замер на 375 px:
       * `grid-template-columns: 73.25px 73.25px 73.25px 73.25px` — карточка
       * шириной 73 пикселя, оттого цена и разваливалась на три строки.
       */
      '@media(max-width:1024px){.ngr-shelf{grid-template-columns:repeat(3,1fr)!important}}' +
      '@media(max-width:760px){.ngr-shelf{grid-template-columns:repeat(2,1fr)!important;' +
      'gap:12px!important}' +
      '.ngr-sc__b{padding:11px;gap:6px}.ngr-sc__t{font-size:13px}' +
      '.ngr-sc__now{font-size:16px;padding:4px 9px}}';
    document.head.appendChild(st);
  }

  /**
   * Блок вопросов на главной свёрстан жёсткой сеткой из двух колонок
   * 300 и 480 точек. На экранах около девятисот точек это не помещается,
   * и вся страница получает поперечную прокрутку — заметно на планшете
   * (проверка 16.08). Делаем колонки гибкими и на узких складываем в одну.
   */
  function faqCss() {
    if (document.getElementById('ngr-faq-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-faq-css';
    st.textContent =
      '.ngr-faq{grid-template-columns:minmax(0,300px) minmax(0,1fr)!important}' +
      '.ngr-faq__list{width:auto!important;max-width:100%!important;min-width:0!important}' +
      '@media(max-width:1000px){.ngr-faq{grid-template-columns:minmax(0,1fr)!important}}';
    document.head.appendChild(st);
  }

  /**
   * Метка на корзине показывается только при товаре в ней.
   *
   * Tilda рисует красный кружок постоянно, а число в нём оставляет пустым,
   * когда корзина пуста. Со стороны это выглядит как «вас что-то ждёт»,
   * хотя ждать нечего (замечание Александра 16.08). Считаем товары сами:
   * у Tilda корзина живёт в объекте tcart, и он же обновляется при
   * добавлении.
   */
  function меткаКорзины() {
    var сколько = 0;
    try {
      if (window.tcart && Array.isArray(tcart.products)) {
        tcart.products.forEach(function (p) { сколько += Number(p.quantity) || 1; });
      }
    } catch (e) { return; }
    var пусто = сколько < 1;
    document.documentElement.classList.toggle('ngr-corzina-pusta', пусто);
    // Правилом стиля это не убрать: Tilda задаёт показ счётчика с большей
    // силой. Ставим прямо на элемент — тогда решает наш стиль.
    document.querySelectorAll('.t706__carticon-counter').forEach(function (c) {
      var надо = пусто ? 'none' : '';
      if (пусто) {
        if (c.style.display !== 'none') c.style.setProperty('display', 'none', 'important');
      } else if (c.style.display === 'none') {
        c.style.removeProperty('display');
      }
    });
  }

  /**
   * Значок вкладки.
   *
   * В разметке стоял свой значок, но размером 1254 на 1254 точки и весом
   * 755 килобайт — для вкладки это не иконка, а картинка, и браузеры
   * подставляли вместо неё собственную заглушку (замечание Александра 16.08).
   * Подкладываем те же изображения в нормальных размерах, включая значок
   * для домашнего экрана телефона.
   */
  var ЗНАЧКИ = 'https://pikhtachoo.github.io/nutrygo-pvz/img/favicon/';

  function значокВкладки() {
    if (document.getElementById('ngr-favicon-32')) return;
    // Старые ссылки убираем: браузер берёт последнюю подходящую, и тяжёлая
    // картинка продолжила бы выигрывать.
    document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
      .forEach(function (l) { l.parentNode.removeChild(l); });
    [
      { id: 'ngr-favicon-32', rel: 'icon', type: 'image/png', sizes: '32x32', file: 'favicon-32.png' },
      { id: 'ngr-favicon-48', rel: 'icon', type: 'image/png', sizes: '48x48', file: 'favicon-48.png' },
      { id: 'ngr-favicon-apple', rel: 'apple-touch-icon', sizes: '180x180', file: 'apple-touch-icon.png' }
    ].forEach(function (з) {
      var l = document.createElement('link');
      l.id = з.id;
      l.rel = з.rel;
      if (з.type) l.type = з.type;
      if (з.sizes) l.sizes = з.sizes;
      l.href = ЗНАЧКИ + з.file;
      document.head.appendChild(l);
    });
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
  /**
   * Сколько товаров показывать на полке.
   *
   * Полка выкладывается в 4 колонки на широком экране, в 3 на планшете
   * и в 2 на телефоне. Когда число товаров не кратно колонкам, последний
   * ряд остаётся обрубком: на компьютере было видно четыре карточки
   * и две сиротливо под ними (замечание Александра 16.08).
   *
   * Поэтому: на широком экране показываем больше, на узком меньше — листать
   * телефон бесконечно неудобно, — и всегда обрезаем до полного ряда.
   */
  function колонокПолки() {
    var w = window.innerWidth;
    if (w <= 760) return 2;
    if (w <= 1024) return 3;
    return 4;
  }

  function сколькоНаПолке(всего) {
    var колонок = колонокПолки();
    // Два ряда на любом экране: 8 карточек на компьютере, 6 на планшете,
    // 4 на телефоне. Смотрится одинаково опрятно и не заставляет крутить.
    var хочется = колонок * 2;
    var можно = Math.min(всего, хочется);
    // Обрезаем до полного ряда, но пустой полки не допускаем.
    var ровно = Math.floor(можно / колонок) * колонок;
    return ровно || можно;
  }

  /*
   * Какой кусок подборки показать сейчас.
   *
   * «Хочется, чтобы они менялись периодически, а не были статичны»
   * (Александр, 16.08). Сервер присылает запас, а витрина берёт из него
   * окно, которое сдвигается каждый час. Час — не случайность: в пределах
   * одного посещения подборка не скачет, а за день успевает смениться
   * несколько раз. Сдвиг у каждой полки свой, иначе они менялись бы
   * одинаково и это бросалось бы в глаза.
   */
  function окноПодборки(list, сколько, соль) {
    if (!list.length || list.length <= сколько) return list.slice(0, сколько);
    var час = Math.floor(Date.now() / 3600000);
    var шагов = Math.ceil(list.length / сколько);
    var шаг = ((час + (соль || 0)) % шагов + шагов) % шагов;
    var с = шаг * сколько;
    var кусок = list.slice(с, с + сколько);
    // Хвост короче окна дополняем с начала, чтобы ряд остался полным.
    if (кусок.length < сколько) кусок = кусок.concat(list.slice(0, сколько - кусок.length));
    return кусок;
  }

  function buildShelf(host, list, соль) {
    host.innerHTML = '';
    host.classList.add('ngr-shelf');
    var сколько = сколькоНаПолке(list.length);
    host.setAttribute('data-ngr-колонок', колонокПолки());
    окноПодборки(list, сколько, соль).forEach(function (c) { host.appendChild(shelfCard(c)); });
  }

  /*
   * При смене размера окна число колонок меняется, и вчерашняя раскладка
   * снова даёт обрубок. Пересобираем полки — но не на каждый пиксель, а
   * когда число колонок действительно стало другим.
   */
  var полкиТаймер = null;
  window.addEventListener('resize', function () {
    clearTimeout(полкиТаймер);
    полкиТаймер = setTimeout(function () {
      var надо = String(колонокПолки());
      document.querySelectorAll('.ngr-shelf').forEach(function (host) {
        if (host.getAttribute('data-ngr-колонок') === надо) return;
        // Пересборкой займётся общий обход: снимаем нашу сетку, и он вернёт её
        // уже с правильным числом карточек.
        host.innerHTML = '';
        host.removeAttribute('data-ngr-колонок');
      });
      if (typeof fixShelves === 'function') fixShelves();
    }, 250);
  });

  /*
   * Ряд товаров на главной.
   *
   * Tilda рисует в нём восемь карточек, но часть товаров к этому моменту уже
   * разобрали, и мы их прячем — покупателю доставалось шесть, ряд выходил
   * рваным (замечание Александра 16.08: «в итоге всё равно 6»). Дополняем
   * ряд своими карточками из той же подборки, что и полки ниже, и меняем
   * их каждый час — статичная витрина приедается.
   *
   * Когда покупатель ищет или отбирает товар, не вмешиваемся вовсе: он
   * должен видеть ровно то, что нашлось, без наших добавок.
   */
  function идётОтбор() {
    if (/tfc_/.test(location.search)) return true;
    var поиск = document.querySelector('.js-catalog-filter-search, input[name="query"]');
    if (поиск && String(поиск.value || '').trim()) return true;
    return !!document.querySelector('.t-catalog__chosen-bar__item, .t-store__filter__chosen-item');
  }

  function дополнитьГлавную() {
    if (!shelves || onCatalogPage()) return;
    var сетка = document.querySelector('.t-catalog__card-list');
    if (!сетка) return;

    var добавленные = [].slice.call(сетка.querySelectorAll('[data-ngr-fill]'));
    if (идётОтбор()) {
      добавленные.forEach(function (e) { e.remove(); });
      return;
    }

    var чужие = [].slice.call(сетка.querySelectorAll('.js-product'));
    var видно = чужие.filter(function (k) { return k.getBoundingClientRect().width > 0; });
    var колонок = колонокПолки();
    /*
     * Дополняем до полного ряда, а не до заранее назначенного числа.
     * Товаров в наличии то больше, то меньше, и жёсткая цифра оставляла
     * хвост: на телефоне выходило пять карточек — два ряда и одинокая
     * пятая. Ничего не прячем, только добираем недостающие места.
     */
    var надо = Math.max(колонок * 2, Math.ceil(видно.length / колонок) * колонок);
    /*
     * Дополняем только обычную выдачу.
     *
     * Если своих карточек меньше ряда, значит показана не витрина, а
     * что-то узкое — например, найденный товар. Добивать такой список
     * посторонними товарами нельзя: покупатель решит, что это тоже
     * находки. Проверка по числу надёжнее любых признаков поиска.
     */
    if (видно.length < колонок) {
      добавленные.forEach(function (e) { e.remove(); });
      return;
    }
    var нехватка = надо - видно.length;
    if (нехватка === добавленные.length) return;    // уже дополнено ровно так же
    добавленные.forEach(function (e) { e.remove(); });
    if (нехватка <= 0) return;

    // Что уже показано — второй раз не показываем.
    var занято = {};
    видно.forEach(function (k) { var a = article(k); if (a) занято[a] = 1; });

    var запас = (shelves.byReviews || []).concat(shelves.byDiscount || [])
      .filter(function (c) {
        var a = String(c.art || '');
        if (!a || занято[a]) return false;
        занято[a] = 1;
        return true;
      });
    if (!запас.length) return;

    окноПодборки(запас, нехватка, 2).forEach(function (c) {
      var карта = shelfCard(c);
      карта.setAttribute('data-ngr-fill', '1');
      сетка.appendChild(карта);
    });
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
      buildShelf(sale, shelves.byDiscount, 1);
    }

    /*
     * «Чаще всего берут» — полка перед скидками.
     *
     * Раньше проверялось только, есть ли сама полка. Когда обработчик
     * размера окна вычищал её содержимое, вернуть карточки было уже некому,
     * и на главной оставался обрубок в четыре товара вместо восьми
     * (замечание Александра 16.08). Теперь смотрим на содержимое.
     */
    дополнитьГлавную();

    var верх = document.querySelector('.ngr-shelf-top .ngr-shelf');
    if (верх && !верх.querySelector('.ngr-sc') && shelves.byReviews.length) {
      buildShelf(верх, shelves.byReviews, 0);
    }
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
      buildShelf(grid, shelves.byReviews, 0);
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

  /* ---------- Корзина ---------- */

  /**
   * Корзина на телефоне обрезалась сверху: Tilda задаёт окну высоту в 100 %
   * экрана, а на телефоне адресная строка эту высоту съедает — заголовок
   * «Ваш заказ» уходил под верхний край (замечание Александра 08.08).
   * Берём динамическую высоту окна и добавляем отступ под вырез экрана.
   *
   * Заодно приводим состав заказа к нормальному виду: крупная картинка,
   * читаемое название, заметная цена.
   */
  /**
   * Серая выноска с суммой у корзины скрывается стилем в cartCss().
   *
   * Важно: узел .t706__carticon-text обязан оставаться в DOM. Штатный
   * tilda-cart-1.1.min.js обращается к нему без null-check при перерисовке
   * счётчика. Физическое удаление обрывало инициализацию корзины на mobile:
   * window.tcart не создавался, а клик по иконке ничего не открывал.
   */
  function dropCartTip() {
    // Сохраняем обязательную нативную разметку Tilda. Визуальное скрытие —
    // только через CSS ниже, чтобы tcart__reDrawCartIcon не падал на null.style.
  }

  /**
   * Корзина подставляет то, что покупатель уже вводил.
   *
   * Замечание Александра 14.08: «человек тут не пишет номер телефона, имя.
   * Когда он будет создавать заказ, то его профиль должен автоматически
   * заполниться». В тот же день вход в кабинет перевели на одноразовый код
   * с почты — Tilda при таком входе не спрашивает ни имени, ни телефона,
   * так что у нового покупателя в профиле нет ничего, кроме адреса почты.
   * Значит источник данных один: прошлый заказ этого человека.
   *
   * Берём по порядку — что вводили в прошлый раз на этом устройстве, затем
   * профиль Tilda. Заполняем только пустые поля и только один раз на форму:
   * набранное руками не трогаем никогда, стёртое нарочно не возвращаем.
   *
   * Пункт выдачи и адрес не подставляем сознательно. Адрес пишет виджет
   * вместе с номером пункта, и если вписать туда прошлый адрес, номер
   * останется от прежнего выбора: заказ уедет не в тот пункт, а покупатель
   * увидит в корзине верную строку. Цена ошибки здесь выше пользы.
   */
  var КЛЮЧ_ПОКУПАТЕЛЯ = 'ngr_buyer_v1';

  function покупательИзПамяти() {
    try { return JSON.parse(localStorage.getItem(КЛЮЧ_ПОКУПАТЕЛЯ) || 'null') || {}; }
    catch (e) { return {}; }
  }

  function запомнитьПокупателя(v) {
    var cur = покупательИзПамяти();
    ['name', 'phone', 'email'].forEach(function (k) { if (v[k]) cur[k] = v[k]; });
    try { localStorage.setItem(КЛЮЧ_ПОКУПАТЕЛЯ, JSON.stringify(cur)); } catch (e) {}
  }

  /** Профиль Tilda лежит в браузере под ключом с номером проекта. */
  function покупательИзПрофиля() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf('tilda_members_profile') !== 0 || /_timestamp$/.test(k)) continue;
        var p = JSON.parse(localStorage.getItem(k) || 'null');
        if (p) return { name: p.name || '', phone: p.phone || '', email: p.login || p.email || '' };
      }
    } catch (e) {}
    return {};
  }

  function цифрыТелефона(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 10) d = '7' + d;
    if (d.length === 11 && d.charAt(0) === '8') d = '7' + d.slice(1);
    return d.length === 11 ? d : '';
  }

  /**
   * 79161234567 → +7 (916) 123-45-67. Незнакомое оставляем как есть.
   *
   * В поле попадает и номер из профиля Tilda, а там человек мог записать
   * его с восьмёрки или без кода страны — приводим к одному виду.
   */
  function телефонДляГлаз(v) {
    var d = цифрыТелефона(v);
    if (d.length !== 11 || d.charAt(0) !== '7') return String(v || '');
    return '+7 (' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9);
  }

  function вписать(поле, знач) {
    if (!поле || !знач || поле === document.activeElement) return false;
    if (String(поле.value || '').trim()) return false;
    поле.value = знач;
    поле.dispatchEvent(new Event('input', { bubbles: true }));
    поле.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /**
   * Телефон у Tilda собран из трёх полей: видимая маска без кода страны,
   * скрытый Phone с кодом и скрытый iso. Замер 14.08: достаточно вписать
   * маску и послать input — обработчик Tilda сам пересчитал Phone
   * («+7 (905) 333-85-34») и iso. Скрытые поля дописываем только если он
   * почему-то не сработал: заказ без номера в пункте выдачи не отдадут.
   *
   * И только вслед за видимой маской. Замер 14.08: когда маску заполнить не
   * удалось (в ней стоял курсор), скрытое поле всё равно получало номер —
   * покупатель видел пустую строку телефона, а заказ уходил с номером,
   * которого он не видел. Такого расхождения быть не должно.
   */
  function вписатьТелефон(form, цифры) {
    if (!цифры) return;
    var маска = form.querySelector('input.t-input-phonemask') ||
                form.querySelector('input[type="tel"]');
    var n = цифры.slice(1);
    if (!вписать(маска, '(' + n.slice(0, 3) + ') ' + n.slice(3, 6) + '-' +
                        n.slice(6, 8) + '-' + n.slice(8))) return;
    var скрытое = form.querySelector('input[name="Phone"]');
    if (скрытое && String(скрытое.value || '').replace(/\D/g, '').length < 11) {
      скрытое.value = '+' + цифры;
      скрытое.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function cartForm() {
    var mark = document.querySelector('input[name="tildaspec-formname"][value="Cart"]');
    return (mark && mark.form) || null;
  }

  function prefillCart() {
    var form = cartForm();
    if (!form || form.__ngrPrefill) return;
    var свои = покупательИзПамяти();
    var профиль = покупательИзПрофиля();
    var имя = свои.name || профиль.name || '';
    var почта = свои.email || профиль.email || '';
    var тел = цифрыТелефона(свои.phone || профиль.phone || '');
    if (!имя && !почта && !тел) return;
    form.__ngrPrefill = 1;
    вписать(form.querySelector('input[name="Name"]'), имя);
    вписать(form.querySelector('input[name="Email"]'), почта);
    вписатьТелефон(form, тел);
  }

  /**
   * Запоминаем покупателя в тот момент, когда он отправляет заказ: это
   * единственная точка, где имя, почта и телефон заведомо заполнены и
   * проверены самой Tilda.
   */
  /*
   * Почта в заказе против почты аккаунта.
   *
   * Разбор 16.08: в заказе стояло «pikhtonikov.alieksandr@» вместо
   * «pikhtovnikov.alieksandr@» — пропущена буква. Письма о заказе исправно
   * уходили в никуда, и покупатель никак не мог об этом узнать: ошибку
   * видно только по тому, что письма нет.
   *
   * Поэтому сверяем введённую почту с той, под которой человек вошёл,
   * и предупреждаем при расхождении. Не запрещаем: почта может отличаться
   * намеренно — рабочая, семейная. Но подставить свою даём в одно нажатие.
   */
  function почтаАккаунта() {
    var п = memberProfile();
    return п ? String(п.login || п.email || '').trim().toLowerCase() : '';
  }

  function сверитьПочту(поле) {
    if (!поле) return;
    var своя = почтаАккаунта();
    var ввод = String(поле.value || '').trim().toLowerCase();
    var форма = поле.form;
    if (!форма) return;
    var плашка = форма.querySelector('.ngr-mailwarn');
    if (!своя || !ввод || ввод === своя || ввод.indexOf('@') < 1) {
      if (плашка) плашка.remove();
      return;
    }
    if (плашка && плашка.getAttribute('data-for') === ввод) return;
    if (плашка) плашка.remove();
    плашка = document.createElement('div');
    плашка.className = 'ngr-mailwarn';
    плашка.setAttribute('data-for', ввод);
    плашка.style.cssText = 'margin:8px 0 14px;padding:12px 14px;border:1px solid #f0c9a3;' +
      'background:#fff7ef;border-radius:11px;color:#7a4a12;font-size:13px;line-height:1.5;' +
      'visibility:visible!important;transition:none!important';
    плашка.innerHTML = '<b>Проверьте почту — письма о заказе придут на неё.</b><br>' +
      'Вы вошли под <b class="ngr-mailwarn__my"></b>, а в заказе указана ' +
      '<b class="ngr-mailwarn__typed"></b>.<br>' +
      '<button type="button" class="ngr-mailwarn__fix" style="margin-top:9px;padding:8px 14px;' +
      'border:0;border-radius:9px;background:#ff7a1a;color:#fff;font-weight:700;cursor:pointer">' +
      'Подставить почту аккаунта</button>';
    плашка.querySelector('.ngr-mailwarn__my').textContent = своя;
    плашка.querySelector('.ngr-mailwarn__typed').textContent = ввод;
    плашка.querySelector('.ngr-mailwarn__fix').addEventListener('click', function () {
      var задать = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      задать.call(поле, своя);
      поле.dispatchEvent(new Event('input', { bubbles: true }));
      поле.dispatchEvent(new Event('change', { bubbles: true }));
      плашка.remove();
    });
    var куда = поле.closest('.t-input-group') || поле.parentNode;
    куда.parentNode.insertBefore(плашка, куда.nextSibling);
  }

  document.addEventListener('input', function (e) {
    var п = e.target;
    if (п && п.name === 'Email') сверитьПочту(п);
  }, true);
  document.addEventListener('blur', function (e) {
    var п = e.target;
    if (п && п.name === 'Email') сверитьПочту(п);
  }, true);

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.querySelector) return;
    var mark = f.querySelector('input[name="tildaspec-formname"]');
    if (!mark || mark.value !== 'Cart') return;
    var скрытое = (f.querySelector('input[name="Phone"]') || {}).value || '';
    var маска = (f.querySelector('input.t-input-phonemask') || {}).value || '';
    var a = String(скрытое).replace(/\D/g, ''), b = String(маска).replace(/\D/g, '');
    var имяЗаказа = ((f.querySelector('input[name="Name"]') || {}).value || '').trim();
    var телефонЗаказа = цифрыТелефона(a.length >= b.length ? a : b);
    запомнитьПокупателя({
      name: имяЗаказа,
      email: ((f.querySelector('input[name="Email"]') || {}).value || '').trim(),
      phone: телефонЗаказа
    });
    /*
     * То же самое дописываем в профиль на сервере.
     *
     * Раньше имя и телефон оставались в памяти браузера, и на другом
     * устройстве покупатель набирал их заново (замечание Александра 16.08).
     * Ответа не ждём: заказ уходит своим ходом, а если связь подвела,
     * ничего не ломается — данные всё равно сохранены на устройстве.
     */
    if ((имяЗаказа || телефонЗаказа) && memberToken()) {
      try {
        accountPost('merge', { profile: { name: имяЗаказа, phone: телефонЗаказа } })
          .then(applyAccountSnapshot)
          .catch(function () {});
      } catch (err) {}
    }
  }, true);

  /**
   * Строка фильтров Tilda: то, что осталось на главной.
   *
   * Замечания Александра 08.08: верхняя лента разделов дублирует фильтр,
   * «Наличие» бессмысленно — мы и так показываем только то, что есть,
   * «Сортировка» повторяет список справа от поиска, а у ползунка цены
   * не видно дорожки. Правим стилями, не трогая саму разметку Tilda,
   * чтобы не задеть подбор товаров.
   */
  function filterBarCss() {
    if (document.getElementById('ngr-fbar-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-fbar-css';
    st.textContent =
      // Лента разделов с полосой прокрутки — то же самое есть в фильтре
      '.t-catalog__parts-switch-wrapper,.t-catalog__parts-above-wrapper{display:none!important}' +
      // Дорожка ползунка цены и залитая часть
      '.t-catalog__filter__range_bg{height:4px!important;border-radius:3px!important;' +
      'background:#e3e8ee!important}' +
      '.t-catalog__filter__price-outer{height:4px!important;border-radius:3px!important;' +
      'background:#4984c4!important}' +
      // Сами ползунки лежат поверх дорожки и закрашены белым — из-за этого
      // полосы не было видно вовсе (замечание Александра 08.08).
      '.t-catalog__filter__range{background:transparent!important;background-color:transparent!important}' +
      '.t-catalog__filter__item-price-slider{padding:10px 4px 6px!important}' +
      '.t-catalog__filter__input{border:1px solid #e3e8ee!important;border-radius:10px!important;' +
      'height:42px!important}' +
      // Сама строка: ровные отступы и перенос вместо обрезки
      '#rec2502703571 .t-catalog__filter{display:flex!important;flex-wrap:wrap!important;gap:10px!important;' +
      'align-items:flex-start!important;background:transparent!important;padding:0!important;' +
      'border-radius:0!important;margin:0 0 14px!important}' +
      // Tilda пересобирает пункты фильтра при фокусе и вводе. Inline-скрытие
      // срабатывало только на следующем JS-проходе, поэтому старые чипы успевали
      // появиться на кадр. Постоянное правило не даёт им участвовать в раскладке
      // ни на главной витрине, ни в полном каталоге.
      '#rec2502703571.ngr-catalog-record .t-catalog__filter__options > .t-catalog__filter__item{display:none!important;margin:0!important}' +
      // Поиск и сортировка уезжали на второй этаж: блок с фильтрами
      // занимал всю ширину. Ставим их в один ряд, справа.
      '.t-catalog__filter__controls-wrapper{align-items:center!important;gap:12px!important}' +
      '#rec2502703571.ngr-catalog-record .t-catalog__filter__controls-wrapper > .t-catalog__filter__options,' +
      '#rec2502703571 .js-catalog-filter-mob-btn,' +
      '#rec2502703571 .js-catalog-sort-mob-btn,' +
      '#rec2502703571 .js-catalog-search-mob-btn,' +
      '#rec2502703571 .js-catalog-search-mob-close-btn{display:none!important}' +
      '#rec2502703571 .t-catalog__filter__search-and-sort{flex:0 0 auto!important;' +
      // 275px — столько же ставит JS и второй блок стилей ниже. Здесь стояло
      // 286, и панель прыгала на 11px при каждом сбросе инлайновых стилей.
      'margin-left:275px!important;display:flex!important;gap:10px!important;align-items:center!important}' +
      '@media(max-width:860px){#rec2502703571 .t-catalog__filter__search-and-sort{margin-left:0!important;' +
      'display:grid!important;grid-template-columns:minmax(104px,.78fr) minmax(0,1.22fr)!important;' +
      'width:100%!important}}' +
      /*
       * В каталоге фильтры живут в своей колонке, и от строки Tilda остаются
       * только поиск и сортировка. Голубая коробка вокруг них выглядела
       * пустой (замечание Александра 08.08). Убираем коробку и ставим
       * их над сеткой товаров, как на Ozon: сортировка слева, поиск рядом.
       */
      // 275px, а не 286: ровно столько ставит JS ниже. Пока значения
      // расходились, панель прыгала на 11px каждый раз, когда Tilda сбрасывала
      // инлайновые стили и страница откатывалась к одному только CSS.
      '#rec2502703571 .t-catalog__filter__search-and-sort{margin-left:275px!important;' +
      'display:flex!important;gap:10px!important;align-items:center!important;width:auto!important}' +
      // Ниже — то, что раньше делал только JS. Пока этого не было в CSS, между
      // сбросом инлайновых стилей и следующим проходом apply страница успевала
      // показать тильдовский вид: голубая коробка вокруг панели, пустой блок
      // фильтров во всю ширину, дублирующие мобильные кнопки. Это и читалось
      // как «переключение стилей поиска» (замечание Александра 13.08).
      '#rec2502703571 .t-catalog__filter{background:transparent!important;padding:0!important;' +
      'border-radius:0!important;margin:0 0 14px!important}' +
      '#rec2502703571 .t-catalog__filter__options{display:none!important}' +
      // Сами элементы строки фильтров — на случай, если Tilda перенесёт их
      // из скрытой обёртки. Раньше их гасил инлайном syncSideFilters на
      // каждом проходе, и между перерисовкой Tilda и проходом строка успевала
      // мелькнуть. Правилу мелькать нечем: оно действует сразу при вставке.
      '#rec2502703571 .t-catalog__filter__item{display:none!important}' +
      '#rec2502703571 .js-catalog-filter-mob-btn,#rec2502703571 .js-catalog-sort-mob-btn,' +
      '#rec2502703571 .js-catalog-search-mob-btn,#rec2502703571 .js-catalog-search-mob-close-btn{' +
      'display:none!important}' +
      // Порядок обязан стоять на обёртках Tilda — это и есть флекс-элементы
      // строки. Ниже те же order задаются из JS, но JS отрабатывает уже после
      // первой отрисовки, и панель успевала прыгнуть: кадр в порядке DOM
      // (поиск слева), затем перестановка (сортировка слева). Правило здесь
      // применяется сразу, поэтому первый же кадр верный, а JS лишь повторяет
      // те же значения. Замечание Александра 13.08 «скачет фильтр».
      '#rec2502703571 .t-catalog__filter__sort{order:0!important}' +
      '#rec2502703571 .t-catalog__filter__search{order:1!important}' +
      // display:block и padding-right:36px — ровно то, что ставит JS ниже.
      // Раньше в CSS было inline-block и 38px, и в кадрах без инлайновых
      // стилей селект вёл себя чуть иначе.
      '#rec2502703571 .t-catalog__sort-select{order:0;height:44px!important;min-width:210px;' +
      'display:block!important;' +
      'border:1px solid #e3e8ee!important;border-radius:12px!important;background:#fff!important;' +
      'font-size:14.5px!important;color:#14171c!important;padding:0 36px 0 14px!important}' +
      '#rec2502703571 .js-catalog-filter-search{order:1;height:44px!important;width:260px!important;' +
      'border:1px solid #e3e8ee!important;border-radius:12px!important;background:#fff!important;' +
      // 42px слева, как и в JS: при 38px слово «Поиск» на пару пикселей
      // наезжало на лупу, и это было видно в момент переключения.
      'font-size:14.5px!important;padding:0 14px 0 42px!important;box-sizing:border-box!important;' +
      'background-image:url("data:image/svg+xml;utf8,' +
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a919b' stroke-width='2'><circle cx='11' cy='11' r='7'/><path d='M20 20l-3.5-3.5'/></svg>" +
      '")!important;background-repeat:no-repeat!important;background-position:14px center!important;' +
      'background-size:18px 18px!important}' +
      // ------------------------------------------------------------------
      // Перекрытие custom.css. На nutry-go.ru лежит отдельный файл
      // /custom.css (478 правил), где панель каталога описана ещё одной
      // схемой оформления, и селекторы там сильнее наших:
      //   #rec2502703571.ngr-catalog-record .t-catalog__filter   (1 id, 2 класса)
      //   #rec2502703571.ngr-catalog-record input, ... select    (1 id, 1 класс, 1 тег)
      // против наших #rec2502703571 .t-catalog__filter (1 id, 1 класс).
      // Оба набора с !important, поэтому решает специфичность — выигрывал
      // custom.css. Класс ngr-catalog-record вешает наш же JS, так что до
      // него правила custom.css не срабатывают, а после срабатывают: отсюда
      // и переключение оформления, которое Александр снял на скриншотах
      // 13.08 (лупа наезжает на «Поиск» — это padding-left:14px вместо 42;
      // голубая коробка — background #f5f9fc + border-radius 18 + padding 20;
      // высокая панель — .t-catalog__filter__options{display:flex}).
      // Ниже те же значения, что и выше, но с префиксом html и с классом
      // записи: 1 id + 2-3 класса + тег, то есть заведомо сильнее.
      // Дублирование намеренное: правила без ngr-catalog-record выше нужны
      // для кадров до того, как JS повесил класс.
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter{background:transparent!important;' +
      'border:0!important;border-radius:0!important;padding:0!important;margin:0 0 14px!important}' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__options{display:none!important}' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__item{display:none!important}' +
      // Удвоение класса — обычный приём поднятия специфичности; не завязываемся
      // на имя тега, потому что размётку строки Tilda может поменять.
      'html #rec2502703571.ngr-catalog-record .t-catalog__sort-select.t-catalog__sort-select{' +
      'height:44px!important;min-height:44px!important;font-size:14.5px!important;display:block!important;' +
      'border-radius:12px!important;padding:0 36px 0 14px!important}' +
      'html #rec2502703571.ngr-catalog-record .js-catalog-filter-search.js-catalog-filter-search{' +
      'height:44px!important;min-height:44px!important;font-size:14.5px!important;' +
      'border-radius:12px!important;padding:0 14px 0 42px!important;' +
      'background-position:14px center!important;background-size:18px 18px!important}' +
      // На desktop Tilda задаёт wrapper-ам flex:1. После добавления панели
      // подсказок сортировка забирала все 510px, а host поиска схлопывался в 0.
      '@media(min-width:861px){' +
      '#rec2502703571 .t-catalog__filter__sort{width:210px!important;min-width:210px!important;' +
      'max-width:210px!important;flex:0 0 210px!important}' +
      '#rec2502703571 .t-catalog__filter__search{width:260px!important;min-width:0!important;' +
      'max-width:260px!important;flex:0 0 260px!important}' +
      '#rec2502703571 .t-catalog__filter__sort .t-catalog__sort-select,' +
      '#rec2502703571 .t-catalog__filter__search .js-catalog-filter-search{' +
      'width:100%!important;max-width:100%!important;box-sizing:border-box!important}}' +
      '@media(max-width:860px){#rec2502703571 .t-catalog__filter__search-and-sort{margin-left:0!important;' +
      'display:grid!important;grid-template-columns:minmax(104px,.78fr) minmax(0,1.22fr)!important;' +
      'width:100%!important;min-width:0!important}' +
      '#rec2502703571 .t-catalog__filter__search-and-sort>*{width:100%!important;min-width:0!important}' +
      '#rec2502703571 .js-catalog-filter-search,#rec2502703571 .t-catalog__sort-select{' +
      'width:100%!important;min-width:0!important;max-width:100%!important}}' +
      '@media(max-width:600px){#rec2502703571 .t-catalog__filter__search-and-sort{' +
      'grid-template-columns:minmax(0,1fr)!important}' +
      '#rec2502703571 .t-catalog__filter__search-and-sort>*{grid-column:1!important}}' +
      // Локальные результаты поиска не участвуют в разметке сетки Tilda,
      // поэтому её перерисовка не двигает поле и не забирает фокус.
      '.ngr-smart-search{position:relative!important;min-width:0!important}' +
      '.ngr-smart-search__panel{position:absolute;z-index:10020;left:0;right:auto;top:calc(100% + 6px);' +
      'width:100%;max-width:100%;min-width:0;max-height:480px;max-height:min(55dvh,480px);overflow-y:auto;overflow-x:hidden;' +
      'box-sizing:border-box;background:#fff;border:1px solid #dfe5ec;border-radius:14px;' +
      'box-shadow:0 16px 40px rgba(20,23,28,.16);padding:6px}' +
      '.ngr-smart-search__panel[hidden]{display:none!important}' +
      '.ngr-smart-search__item{display:flex;width:100%;flex-direction:column;align-items:flex-start;' +
      'gap:3px;border:0;border-radius:10px;background:#fff;padding:10px 11px;text-align:left;' +
      'font-family:inherit;color:#14171c;cursor:pointer;min-width:0;max-width:100%;box-sizing:border-box;' +
      'white-space:normal;overflow:hidden;overflow-wrap:anywhere}' +
      '.ngr-smart-search__item:hover,.ngr-smart-search__item:focus{background:#f2f6fa;outline:none}' +
      '.ngr-smart-search__item strong,.ngr-smart-search__item span,.ngr-smart-search__item small{' +
      'width:100%;max-width:100%;min-width:0;box-sizing:border-box;white-space:normal;overflow-wrap:anywhere;word-break:break-word}' +
      '.ngr-smart-search__item strong{font-size:14px;line-height:1.35}' +
      '.ngr-smart-search__item span{font-size:12px;color:#2f6ba8}' +
      '.ngr-smart-search__item small{font-size:12px;line-height:1.35;color:#6f7782;' +
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}' +
      '.ngr-smart-search__note{padding:12px;font-size:13px;line-height:1.4;color:#6f7782}' +
      // Кнопка «Найти» внутри поля: на телефоне другого способа запустить
      // поиск нет — мобильные кнопки Tilda мы прячем (замечание 14.08).
      '.ngr-smart-search__go{position:absolute;right:4px;top:50%;transform:translateY(-50%);' +
      'z-index:3;height:36px;padding:0 14px;border:0;border-radius:9px;background:#f28c28;' +
      'color:#fff;font-family:inherit;font-size:13.5px;font-weight:700;cursor:pointer;line-height:1}' +
      '.ngr-smart-search__go:hover{background:#e07f1c}' +
      // Свои значки Tilda в поле поиска: лупа и крестик очистки. Лупу мы
      // рисуем фоном самого поля, крестик заменяет «Показать все», а у
      // значков есть левая граница — она и осталась тонкой полоской за
      // кнопкой «Найти» (замечание Александра 14.08 со снимком).
      'html #rec2502703571 .t-catalog__search-wrapper > svg,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__search-wrapper > svg{display:none!important}' +
      // Найденное показываем строкой под поиском: сколько нашли и как вернуть всё.
      '.ngr-search-note{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;' +
      'margin:2px 0 12px;font-size:13.5px;color:#42506a;grid-column:1/-1;width:100%}' +
      '.ngr-search-note__off{border:1px solid #e3e8ee;background:#fff;border-radius:9px;' +
      'padding:7px 12px;font-family:inherit;font-size:13px;color:#2f6ba8;cursor:pointer}' +
      '.ngr-search-note__off:hover{background:#f6f8fa}' +
      '#rec2502703571 .js-product.ngr-search-off{display:none!important}' +
      '@media(max-width:600px){#rec2502703571.ngr-catalog-record input.js-catalog-filter-search{font-size:16px!important}' +
      '.ngr-smart-search{width:100%!important;min-width:0!important}' +
      '.ngr-smart-search__panel{left:0;right:auto;width:100%;max-width:100%;min-width:0;' +
      'max-height:50dvh;overflow-x:hidden}}' +
      '.t-catalog__filter__item-title{border-radius:12px!important}' +
      /*
       * Суммы не сжимаем никогда.
       *
       * Замечание Александра 14.08 со снимком: в карточке вместо «1 250 р.»
       * стояло «1 ... р.». Так и есть: у числа в синей плашке своё правило
       * Tilda `overflow:hidden; text-overflow:ellipsis; max-width:100%`, а
       * вся строка цены — флекс, где рядом уживаются плашка, старая цена и
       * значок скидки. В четырёх колонках на 1280 px строке не хватает
       * одного-двух пикселей, и флекс сжимает именно число.
       *
       * Замер 14.08: из шестидесяти видимых карточек три обрезаны на 1–2 px
       * (6 360, 4 600, 4 449). На другом экране и другом шрифте обрезка
       * заметнее — это и попало на снимок.
       *
       * Лечим по существу: числу запрещаем и сжиматься, и обрезаться, а
       * строке цены разрешаем перенос — пусть лучше значок скидки уедет на
       * следующую строку, чем покупатель увидит вместо цены многоточие.
       */
      'html #rec2502703571 .js-catalog-price-wrapper{flex-wrap:wrap!important}' +
      'html #rec2502703571 .t-catalog__card__price,' +
      'html #rec2502703571 .t-catalog__card__price-currency{flex:0 0 auto!important;max-width:none!important}' +
      'html #rec2502703571 .js-product-price,' +
      'html #rec2502703571 .js-catalog-prod-price-val,' +
      'html #rec2502703571 .js-catalog-prod-price-old-val{overflow:visible!important;' +
      'text-overflow:clip!important;max-width:none!important;flex:0 0 auto!important;' +
      'white-space:nowrap!important}' +
      'html #rec2502703571 .ngr-oldprice,html #rec2502703571 .ngr-off{flex:0 0 auto!important;' +
      'white-space:nowrap!important}' +
      /*
       * У оформления строки поиска должен быть один хозяин.
       *
       * Замечание Александра 14.08: «визуально прыгает поиск, от одного
       * визуала к другому», «как будто два кода борются». Так и есть, и вот
       * кто с кем. На сайте лежит /custom.css (72 КБ, июльская схема
       * оформления), где та же строка описана иначе:
       *
       *   #rec2502703571.ngr-catalog-record input,
       *   #rec2502703571.ngr-catalog-record select
       *     { border-color:#cfd9e1!important; min-height:46px!important;
       *       padding-left:14px!important; ... }
       *
       * Специфичность этого правила выше наших, поэтому в стилях выигрывал
       * custom.css, а наш вид держался только инлайновыми стилями, которые
       * дописывал JS. Tilda пересобирает панель на каждую догрузку каталога
       * — за загрузку это тринадцать раз, — и каждый раз новый узел рождался
       * без инлайнов: кадр в оформлении custom.css, потом проход JS
       * возвращал наше. Замер 14.08 на 1280 px показал, что именно менялось:
       *
       *   | свойство         | наш JS   | custom.css |
       *   | border-color     | #e3e8ee  | #cfd9e1    |
       *   | max-width        | none     | 100%       |
       *   | min-width селекта| 0        | 210px      |
       *   | лупа             | один SVG | другой SVG |
       *
       * Лечим не третьим слоем поверх, а тем, что забираем оформление в
       * стили целиком: правила ниже сильнее custom.css, поэтому верен уже
       * первый кадр после вставки узла, и дописывать инлайны больше не
       * нужно — соответствующий кусок trimFilterBar() удалён.
       */
      'html #rec2502703571 .t-catalog__filter__search-and-sort input.js-catalog-filter-search,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort input.js-catalog-filter-search{' +
      'height:44px!important;min-height:44px!important;border:1px solid #e3e8ee!important;' +
      'border-radius:12px!important;background-color:#fff!important;color:#14171c!important;' +
      'box-sizing:border-box!important;min-width:0!important;order:1!important;' +
      // справа место под кнопку «Найти»
      'padding:0 96px 0 42px!important;' +
      'background-image:url("data:image/svg+xml;utf8,' +
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238a919b' stroke-width='2' stroke-linecap='round'><circle cx='11' cy='11' r='7'/><path d='M20 20l-3.6-3.6'/></svg>" +
      '")!important;background-repeat:no-repeat!important;background-position:14px center!important;' +
      'background-size:18px 18px!important}' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort select.t-catalog__sort-select,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort select.t-catalog__sort-select{' +
      'height:44px!important;min-height:44px!important;border:1px solid #e3e8ee!important;' +
      'border-radius:12px!important;background-color:#fff!important;color:#14171c!important;' +
      'box-sizing:border-box!important;min-width:0!important;order:0!important;display:block!important;' +
      'padding:0 36px 0 14px!important}' +
      // Обёртка поиска рисует свою рамку — вертикальная черта рядом с полем.
      'html #rec2502703571 .t-catalog__search-wrapper,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__search-wrapper{border:0!important;' +
      'background:transparent!important;box-shadow:none!important;padding:0!important;' +
      'min-width:0!important}' +
      // Размеры зависят от ширины окна, поэтому — медиазапросами, а не JS.
      // Их место в файле последнее: правила равной силы решает порядок.
      // Граница «широкий экран» — 861 px, а не 1000.
      //
      // Замечание Александра 14.08: «когда с телефона смотришь в режиме ПК,
      // фильтры слева не прогружаются». Колонка при этом собрана и полна —
      // 73 фильтра, — но спрятана: телефон в режиме ПК даёт около 980 px, а
      // это была наша «узкая» полоса, где фильтры живут за кнопкой. В режиме
      // ПК человек ждёт вида ПК, и место под колонку там есть: 861 − 275
      // оставляет под сетку почти 600 px, то есть две карточки в ряд.
      '@media(min-width:861px){' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort{' +
      'display:flex!important;gap:10px!important;align-items:center!important;width:auto!important;' +
      'min-width:0!important;margin-left:275px!important}' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort input.js-catalog-filter-search,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort input.js-catalog-filter-search{' +
      'width:260px!important;max-width:none!important;font-size:14.5px!important}' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort select.t-catalog__sort-select,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort select.t-catalog__sort-select{' +
      'width:210px!important;max-width:none!important;font-size:14.5px!important}' +
      'html #rec2502703571 .t-catalog__search-wrapper{width:auto!important}}' +
      '@media(max-width:860px){' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort{' +
      'display:grid!important;gap:10px!important;align-items:center!important;' +
      'grid-template-columns:minmax(104px,.78fr) minmax(0,1.22fr)!important;' +
      'width:100%!important;min-width:0!important;margin-left:0!important}' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort>*,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort>*{' +
      'display:block!important;width:100%!important;min-width:0!important}' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort input.js-catalog-filter-search,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort input.js-catalog-filter-search,' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort select.t-catalog__sort-select,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort select.t-catalog__sort-select{' +
      'width:100%!important;max-width:100%!important;font-size:14.5px!important}' +
      'html #rec2502703571 .t-catalog__search-wrapper{width:100%!important}}' +
      '@media(max-width:600px){' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort{' +
      'grid-template-columns:minmax(0,1fr)!important}' +
      'html #rec2502703571 .t-catalog__filter__search-and-sort>*,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort>*{grid-column:1!important}' +
      // 16px — чтобы телефон не увеличивал страницу при фокусе в поле.
      'html #rec2502703571 .t-catalog__filter__search-and-sort input.js-catalog-filter-search,' +
      'html #rec2502703571.ngr-catalog-record .t-catalog__filter__search-and-sort input.js-catalog-filter-search{' +
      'font-size:16px!important}}';
    document.head.appendChild(st);
  }

  /**
   * «Наличие» и «Сортировка» из строки фильтров убираем всегда: первое
   * ничего не меняет, второе повторяет список выбора справа. Прячем стилем
   * на самом элементе — разметка Tilda пересобирается, и класс не удержать.
   */
  function trimFilterBar() {
    // Метка страницы каталога: по ней действуют стили панели над сеткой.
    var cat = onCatalogPage();
    document.documentElement.classList.toggle('ngr-catpage', cat);

    /*
     * Оформление панели каталога целиком в таблице стилей (filterBarCss).
     *
     * Раньше те же значения дописывались отсюда инлайном. Замер 14.08
     * показал, что все шесть узлов — сама панель, пустой блок фильтров и
     * четыре мобильные кнопки Tilda — выглядят одинаково с инлайнами и без
     * них: правила уже сильнее чужих, а проход JS переписывал их тем же
     * самым. Для строки поиска расхождение было настоящим (цвет рамки,
     * лупа, ширины) — из-за него вид и переключался на глазах. Теперь
     * хозяин один: стили.
     */

    // Ползунки цены закрашены белым и прячут дорожку. Правило со стилем
    // Tilda перебивает своим, поэтому снимаем фон прямо на элементах.
    document.querySelectorAll('.t-catalog__filter__range').forEach(function (r) {
      if (r.style.backgroundColor !== 'transparent') {
        r.style.setProperty('background-color', 'transparent', 'important');
        r.style.setProperty('background-image', 'none', 'important');
      }
    });

    // Ленту разделов Tilda перебивает своим стилем позже нашего, поэтому
    // гасим её на самом элементе — иначе правило не действует.
    document.querySelectorAll('.t-catalog__parts-switch-wrapper').forEach(function (e) {
      if (e.style.display !== 'none') e.style.setProperty('display', 'none', 'important');
    });
    // Подпись под заголовком витрины не нужна (решение Александра 08.08).
    document.querySelectorAll('p').forEach(function (e) {
      if (e.children.length || e.style.display === 'none') return;
      if (!/Цены и наличие обновляются из товарного каталога/.test(e.textContent || '')) return;
      e.style.setProperty('display', 'none', 'important');
    });
    document.querySelectorAll('.t-catalog__filter__item').forEach(function (it) {
      var name = ((it.querySelector('.t-catalog__filter__item-title') || {}).textContent || '').trim();
      if (!/^(наличие|сортировка)$/i.test(name)) return;
      if (it.style.display !== 'none') it.style.setProperty('display', 'none', 'important');
    });
  }

  /* ---------- Поиск документов ---------- */

  /**
   * На странице документов было поле ввода без всякой начинки. Подключаем
   * его к каталогу: ищем по названию, бренду и артикулу и показываем номер
   * свидетельства о госрегистрации (замечание Александра 08.08).
   */
  var docsTimer = null;

  function docsSearch() {
    if (!/\/documents/.test(location.pathname)) return;
    var inp = null;
    document.querySelectorAll('input').forEach(function (i) {
      if (/название|артикул|sku/i.test(i.placeholder || '')) inp = i;
    });
    if (!inp || inp.getAttribute('data-ngr-docs')) return;
    inp.setAttribute('data-ngr-docs', '1');

    if (!document.getElementById('ngr-docs-css')) {
      var st = document.createElement('style');
      st.id = 'ngr-docs-css';
      st.textContent =
        '.ngr-docs{margin:14px 0 0;font-family:inherit}' +
        '.ngr-docs__row{display:flex;gap:12px;align-items:center;padding:12px 14px;' +
        'border:1px solid #e8ecf1;border-radius:12px;background:#fff;margin-bottom:8px;flex-wrap:wrap}' +
        '.ngr-docs__t{flex:1 1 260px;min-width:0;font-size:14px;color:#14171c;line-height:1.35}' +
        '.ngr-docs__a{font-size:12.5px;color:#8a919b;white-space:nowrap}' +
        '.ngr-docs__s{font-size:12.5px;font-weight:700;color:#2f7a4f;white-space:nowrap}' +
        '.ngr-docs__s_no{color:#8a919b;font-weight:600}' +
        '.ngr-docs__go{font-size:13px;color:#2f6ba8;text-decoration:none;white-space:nowrap}' +
        '.ngr-docs__note{font-size:13.5px;color:#8a919b;padding:10px 2px}';
      document.head.appendChild(st);
    }

    var box = document.createElement('div');
    box.className = 'ngr-docs';
    var after = inp.closest('div') || inp.parentNode;
    after.parentNode.insertBefore(box, after.nextSibling);

    function draw(text) { box.innerHTML = '<div class="ngr-docs__note">' + text + '</div>'; }

    function run() {
      var q = (inp.value || '').trim();
      if (q.length < 2) { box.innerHTML = ''; return; }
      draw('Ищем…');
      fetch(API + '/catalog/search?q=' + encodeURIComponent(q) + '&limit=30')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var list = (j && j.items) || [];
          if (!list.length) { draw('Ничего не нашли. Проверьте написание или отправьте запрос ниже.'); return; }
          box.innerHTML = '';
          list.forEach(function (it) {
            var row = document.createElement('div');
            row.className = 'ngr-docs__row';
            var t = document.createElement('div');
            t.className = 'ngr-docs__t';
            t.textContent = it.title;
            var a = document.createElement('span');
            a.className = 'ngr-docs__a';
            a.textContent = 'Артикул ' + it.art;
            var s2 = document.createElement('span');
            s2.className = 'ngr-docs__s' + (it.sgr ? '' : ' ngr-docs__s_no');
            s2.textContent = it.sgr ? 'СГР ' + it.sgr : 'СГР уточняется';
            var go = document.createElement('a');
            go.className = 'ngr-docs__go';
            go.href = '/?ngprod=' + encodeURIComponent(it.art);
            go.textContent = 'Открыть товар';
            row.appendChild(t); row.appendChild(a); row.appendChild(s2); row.appendChild(go);
            box.appendChild(row);
          });
        })
        .catch(function () { draw('Не удалось выполнить поиск, попробуйте ещё раз.'); });
    }

    inp.addEventListener('input', function () {
      clearTimeout(docsTimer);
      docsTimer = setTimeout(run, 350);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(docsTimer); run(); }
    });
  }

  /*
   * Кнопка «Применить» у промокода.
   *
   * В оформлении заказа она выглядела чёрной полосой во всю ширину под полем
   * (снимок Александра 17.08). Причина — встроенные стили, которые Tilda
   * пишет прямо в элементы поверх наших правил: обёртке `display:table`,
   * самой кнопке `height:auto`. Замер на живой странице: обёртка table,
   * кнопка 896 на 20 точек вместо 124 на 54.
   *
   * Встроенный стиль сильнее правила по классу, но слабее правила с
   * `!important` — им и возвращаем задуманную раскладку: поле в строку,
   * кнопка справа от него.
   *
   * Правило продублировано в `custom.css` сайта, но тот живёт только внутри
   * Tilda: при пересборке оформления он потеряется, а это — нет.
   */
  function promoBtnCss() {
    if (document.getElementById('ngr-promo-btn-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-promo-btn-css';
    st.textContent =
      '.ngr-ready .t-inputpromocode__wrapper{display:flex!important}' +
      // Чёрная кнопка в оранжевой форме выглядела чужой (замечание Александра
      // 17.08). Берём тот же цвет и тот же цвет текста, что у «Оформить заказ».
      '.ngr-ready .t-inputpromocode__btn{height:54px!important;' +
      'background:var(--ngr-orange)!important;color:var(--ngr-ink)!important}' +
      '.ngr-ready .t-inputpromocode__btn:hover{background:var(--ngr-orange-dark)!important}';
    document.head.appendChild(st);
  }

  /*
   * «В корзину» на карточке пропадала на телефоне.
   *
   * Замер 17.08 на ширине 375: у ссылки `.ng2-brand-buy` шрифт 0 и высота 0 —
   * значит нажать её пальцем нельзя вовсе, и купить с карточки на телефоне
   * было невозможно, только через «Подробнее» и окно товара. Причина не в ней:
   * `font-size: 0` стоит выше по дереву у сетки каталога (приём против
   * пробелов между блоками) и наследуется всем, что не задало размер само.
   * На широком экране размер приходит из другого правила — 16 пикселей, —
   * а на узком не приходит ниоткуда.
   *
   * Заодно делаем её нормальной кнопкой под палец: 40 точек высоты.
   * `:not([hidden])` обязателен — когда товар уже в корзине, сайт прячет эту
   * ссылку и показывает счётчик количества; перебивать это нельзя.
   */
  function мобильнаяКарточкаCss() {
    if (document.getElementById('ngr-mobile-card-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-mobile-card-css';
    st.textContent =
      // Граница — 960, как у самой Tilda: это она в `@media (max-width:960px)`
      // ставит сетке каталога `font-size: 0`. Сначала правило стояло до 760,
      // и между 761 и 960 — планшеты — кнопка оставалась мёртвой.
      '@media (max-width:960px){' +
      '.ngr-ready .t-catalog__card .ng2-brand-buy:not([hidden]){' +
      'font-size:13px!important;line-height:1.25!important;min-height:40px!important;' +
      'display:flex!important;align-items:center!important;justify-content:center!important}' +
      /*
       * Снимок был уже текста под ним (замечание Александра 17.08:
       * «текст шире чем сама картинка, выглядит нелогично»).
       *
       * Причина — в пропорциях: фотографии товаров вертикальные, 900×1200,
       * а рамка квадратная, и при вписывании снимок сжимался до 121 точки
       * при 135 у текста. Ставим рамке пропорцию самого снимка — он
       * заполняет всю ширину карточки и становится заметно крупнее.
       * `padding-bottom` обнуляем: квадрат Tilda держит именно им.
       */
      '.ngr-ready .t-catalog__card .t-catalog__card__imgwrapper{' +
      'aspect-ratio:3/4!important;padding-bottom:0!important;height:auto!important}' +
      // То же на полках «Чаще всего берут» и «Скидки недели» — там наша вёрстка.
      '.ngr-ready .ngr-sc__pic{aspect-ratio:3/4!important}' +
      '}';
    document.head.appendChild(st);
  }

  function cartCss() {
    if (document.getElementById('ngr-cart-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-cart-css';
    st.textContent =
      // Серая выноска с суммой выезжает при наведении на корзину
      // и портит вид (замечание Александра 08.08). Значок и счётчик
      // остаются, выноску убираем.
      '.ngr-ready .t706__carticon .t706__carticon-text{display:none!important}' +
      '@supports (height:100dvh){' +
      '.t706__cartwin{height:100dvh!important;max-height:100dvh!important}}' +
      '.t706__cartwin-content{-webkit-overflow-scrolling:touch}' +
      // Позиция заказа
      '.t706__product{align-items:flex-start!important}' +
      '.t706__product-thumb{width:74px!important;height:74px!important;border-radius:10px!important;' +
      'background-size:contain!important;background-repeat:no-repeat!important;background-position:center!important;' +
      'border:1px solid #eef1f5!important}' +
      '.t706__product-title{font-size:14px!important;line-height:1.45!important;color:#14171c!important}' +
      '.t706__product-amount,.t706__product-price{font-size:15px!important;font-weight:700!important;color:#14171c!important}' +
      '.t706__cartwin-prodamount-wrap{font-size:18px!important;font-weight:800!important;color:#14171c!important}' +
      '@media(max-width:640px){' +
      '.t706__cartwin-content{padding-top:calc(env(safe-area-inset-top, 0px) + 22px)!important;' +
      'padding-bottom:calc(env(safe-area-inset-bottom, 0px) + 26px)!important;max-height:100dvh!important}' +
      '.t706__cartwin-heading,.t706__cartwin-top{position:sticky;top:0;z-index:3;background:#fff;' +
      'padding-top:6px!important;padding-bottom:8px!important}' +
      '.t706__product{gap:12px!important}' +
      '.t706__product-thumb{width:62px!important;height:62px!important;flex:0 0 62px!important}' +
      '.t706__product-title{font-size:13.5px!important}' +
      '.t706__product-plusminus{margin-top:8px!important}' +
      // На узком экране штатный контейнер иконки растягивался до 146 px
      // и перекрывал ссылки второй колонки. Кликабельной остаётся только
      // компактная круглая кнопка в безопасном отступе.
      '.ngr-ready .t706__carticon{left:auto!important;right:12px!important;' +
      'bottom:calc(12px + env(safe-area-inset-bottom,0px))!important;width:56px!important;' +
      'min-width:56px!important;max-width:56px!important;height:56px!important;padding:0!important;' +
      'display:block!important;box-sizing:border-box!important;pointer-events:none!important}' +
      '.ngr-ready .t706__carticon-wrapper{width:56px!important;height:56px!important;' +
      'pointer-events:auto!important;display:flex!important;align-items:center!important;' +
      'justify-content:center!important;position:relative!important}' +
      /*
       * Значок и счётчик — по центру кружка, а не в углу.
       *
       * Замечание Александра 14.08: «при мобильной вёрстке криво
       * показывается корзина». Замер на 375 px: кружок 56×56 в точке
       * (307,744), а значок 48×48 внутри него — в точке (308,745), то есть
       * прижат к левому верхнему углу вместо середины; счётчик же торчал за
       * правый край кружка на пять пикселей.
       */
      // Значок лежит не прямо в обёртке, а ещё в одной коробке —
      // .t706__carticon-imgwrap; центрировать надо и её, иначе выравнивание
      // обёртки ни на что не влияет (замер 14.08: значок 26×26 оказывался
      // на десять пикселей выше и левее середины кружка).
      '.ngr-ready .t706__carticon-imgwrap{position:static!important;width:100%!important;' +
      'height:100%!important;display:flex!important;align-items:center!important;' +
      'justify-content:center!important;margin:0!important;padding:0!important}' +
      '.ngr-ready .t706__carticon-img{position:static!important;margin:0!important;' +
      'padding:0!important;width:26px!important;height:26px!important;display:block!important}' +
      '.ngr-ready .t706__carticon-counter{pointer-events:auto!important;position:absolute!important;' +
      'top:-2px!important;right:-2px!important;left:auto!important;bottom:auto!important;' +
      'min-width:22px!important;height:22px!important;box-sizing:border-box!important}' +
      // Пустая корзина — пустой кружок. Красная метка без числа висела
      // и когда покупать нечего (замечание Александра 16.08).
      '.ngr-corzina-pusta .t706__carticon-counter{display:none!important}' +
      // Ссылка выхода в заголовке формы не должна выходить за viewport.
      '.t706__cartwin .t706__auth{display:flex!important;flex-wrap:wrap!important;gap:6px 10px!important;' +
      'align-items:center!important}' +
      '.t706__cartwin .js-cart-log-out{position:static!important;right:auto!important;' +
      'max-width:100%!important;box-sizing:border-box!important;overflow-wrap:anywhere}' +
      '.t706__cartwin-bottom .t-form__submit button,.t706__cartwin-bottom .t-submit{' +
      'position:sticky;bottom:0;font-size:16px!important;padding:16px!important}}' +
      /*
       * Крестик закрытия корзины — ровно в середине своей кнопки.
       *
       * Замечание Александра 14.08: «неровно находятся значки креста или
       * круга, когда открываешь корзину». Замер на 1280 px: обёртка креста
       * 43×43 в точке (1227,10), а кнопка внутри — шириной 23, и сам значок
       * начинался на десять пикселей правее её левого края, вылезая за
       * кнопку. Задаём середину явно, чтобы не зависеть от чужих отступов.
       */
      'html .t706__cartwin .t706__close.t706__cartwin-close{width:44px!important;height:44px!important;' +
      'display:flex!important;align-items:center!important;justify-content:center!important;padding:0!important}' +
      'html .t706__cartwin .t706__close-button{width:100%!important;height:100%!important;' +
      'display:flex!important;align-items:center!important;justify-content:center!important;' +
      'padding:0!important;margin:0!important}' +
      'html .t706__cartwin .t706__close-button svg{display:block!important;margin:0!important}';
    document.head.appendChild(st);
  }

  /* ---------- Боковая колонка фильтров ---------- */

  var sideReturnFocus = null;

  function closeSideFilters() {
    var live = document.querySelector('.ngr-side_open');
    if (live) {
      live.classList.remove('ngr-side_open');
      live.removeAttribute('aria-modal');
    }
    document.documentElement.classList.remove('ngr-side-lock');
    if (sideReturnFocus && sideReturnFocus.isConnected) {
      try { sideReturnFocus.focus({ preventScroll: true }); } catch (e) { sideReturnFocus.focus(); }
    }
  }

  function openSideFilters(button) {
    var live = document.querySelector('.ngr-side');
    if (!live) return;
    sideReturnFocus = button || document.activeElement;
    live.classList.add('ngr-side_open');
    live.setAttribute('aria-modal', 'true');
    document.documentElement.classList.add('ngr-side-lock');
    var first = live.querySelector('.ngr-side__close');
    if (first) first.focus();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.querySelector('.ngr-side_open')) {
      e.preventDefault();
      closeSideFilters();
    }
  });

  /**
   * Фильтры вынесены в боковую колонку, как на маркетплейсах (запрос
   * Александра 08.08). Своих фильтров не изобретаем: колонка отражает
   * настоящие фильтры Tilda и нажимает их флажки — значит отбор работает
   * ровно так же, как раньше, и ничего не ломается.
   */
  // Фирменные логотипы от дизайнера (папка «ФОТО/Логотипы», Александр 08.08).
  // Своего знака нет у 21st Century, Doctors Best, Smartlife и Thorne —
  // эти бренды показываем просто названием.
  var LOGOS = 'https://pikhtachoo.github.io/nutrygo-pvz/img/';
  var BRAND_LOGO = {
    '21st Century': 'brand-21st-century.png',
    'AllNutrition': 'brand-allnutrition.png',
    'Doctors Best': 'brand-doctors-best.png',
    'California Gold Nutrition': 'brand-california-gold-nutrition.png',
    'Life Extension': 'brand-life-extension.png',
    'NOW': 'brand-now.png',
    'NaturesPlus': 'brand-naturesplus.png',
    'Nutrex': 'brand-nutrex.png',
    'Olimp': 'brand-olimp.png',
    'OstroVit': 'brand-ostrovit.png',
    'Promensil': 'brand-promensil.png',
    'SAN': 'brand-san.png',
    'SFD Nutrition': 'brand-sfd-nutrition.png',
    'Sambucol': 'brand-sambucol.png',
    'Solaray': 'brand-solaray.png',
    'Swanson': 'brand-swanson.png',
    'Ultimate Nutrition': 'brand-ultimate-nutrition.png',
    'UltraVit': 'brand-ultravit.png',
    'VPLAB': 'brand-vplab.png'
  };

  function sideCss() {
    if (document.getElementById('ngr-side-css')) return;
    var st = document.createElement('style');
    st.id = 'ngr-side-css';
    st.textContent =
      /*
       * Зазор только между колонками, но не между строками.
       *
       * Замечание Александра 14.08: «кнопка „загрузить ещё“ срабатывает
       * слишком низко, приходится прокручивать и видеть большой пробел в
       * товарах». Пробел оказался арифметическим: колонка фильтров занимает
       * строки с первой по девяносто девятую, чтобы держаться слева на всю
       * высоту, а зазор в 24px стоит между КАЖДОЙ парой строк. Девяносто
       * восемь пустых зазоров — это 2352 пикселя белизны под товарами.
       *
       * Замер на боевой странице подтвердил ровно эту цифру: высота
       * контейнера 15826 при высоте сетки товаров 13474, разница 2352, и
       * после обнуления зазора строк она обращается в ноль.
       */
      '.ngr-withside{display:grid;grid-template-columns:262px minmax(0,1fr);' +
      'column-gap:24px;row-gap:0;align-items:start}' +
      // Место колонок закреплено, а не задано порядком элементов. После
      // применения фильтра Tilda вставляет первой свою строку «Найдено»,
      // и всё съезжало вправо: товары оказывались в узкой колонке под
      // фильтром, а фильтр занимал витрину (замечание Александра 08.08).
      '.ngr-withside>*{grid-column:2;min-width:0}' +
      '.ngr-withside>.ngr-side{grid-column:1;grid-row:1/span 99}' +
      '.ngr-side{position:sticky;top:14px;background:#fff;border:1px solid #e8ecf1;border-radius:16px;' +
      'padding:6px 4px;max-height:calc(100vh - 28px);overflow:auto}' +
      '.ngr-side__g{border-bottom:1px solid #f1f4f7;padding:14px 14px 12px}' +
      '.ngr-side__g:last-child{border-bottom:0}' +
      '.ngr-side__t{font-size:15px;font-weight:700;color:#14171c;margin-bottom:10px}' +
      '.ngr-side__o{display:flex;align-items:center;gap:9px;padding:6px 0;cursor:pointer;font-size:14px;color:#2b2f36}' +
      '.ngr-side__o:hover{color:#14171c}' +
      // Значения, которых нет в текущей выборке: нажимать не на что.
      '.ngr-side__o.off{opacity:.35;cursor:default}' +
      '.ngr-side__o.off:hover{color:#2b2f36}' +
      '.ngr-side__box{flex:0 0 18px;width:18px;height:18px;border:1.5px solid #cfd6de;border-radius:5px;' +
      'display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;background:#fff}' +
      '.ngr-side__o.on .ngr-side__box{background:#4984c4;border-color:#4984c4}' +
      '.ngr-side__logo{flex:0 0 58px;width:58px;height:22px;' +
      'background:transparent left center/contain no-repeat}' +
      '.ngr-side__more{display:inline-block;margin-top:6px;font-size:13px;color:#2f6ba8;cursor:pointer}' +
      '.ngr-side__price{display:flex;gap:8px;align-items:center}' +
      '.ngr-side__price input{width:100%;min-width:0;padding:9px 10px;border:1px solid #e3e8ee;' +
      'border-radius:9px;font-size:14px;font-family:inherit;color:#14171c}' +
      '.ngr-side__reset{display:block;width:100%;margin:10px 0 4px;padding:11px;border:1px solid #e3e8ee;' +
      'background:#fff;border-radius:10px;font-size:14px;font-weight:600;color:#14171c;cursor:pointer}' +
      '.ngr-side__reset:hover{background:#f6f8fa}' +
      '.ngr-side__up{position:sticky;bottom:8px;left:100%;display:block;opacity:0;pointer-events:none;' +
      'width:38px;height:38px;margin:0 8px 4px auto;border:1px solid #e3e8ee;border-radius:50%;' +
      'background:#fff;color:#14171c;font-size:17px;line-height:1;cursor:pointer;' +
      'box-shadow:0 4px 14px rgba(20,23,28,.12);transition:opacity .18s}' +
      '.ngr-side__up.on{opacity:1;pointer-events:auto}' +
      '.ngr-side__up:hover{background:#f6f8fa}' +
      '.ngr-sidebtn{display:none}' +
      '@media(max-width:860px){' +
      'html.ngr-side-lock,html.ngr-side-lock body{overflow:hidden!important;overscroll-behavior:none}' +
      '.ngr-withside{grid-template-columns:minmax(0,1fr)}' +
      '.ngr-withside>*{grid-column:1}' +
      '.ngr-withside>.ngr-side{grid-column:1;grid-row:auto}' +
      '.ngr-side{position:fixed;inset:0;z-index:99998;border-radius:0;max-height:none;display:none;padding:10px}' +
      '.ngr-side_open{display:block}' +
      '.ngr-sidebtn{display:inline-flex;align-items:center;gap:8px;margin:0 0 12px;padding:11px 18px;' +
      'border:1px solid #e3e8ee;background:#fff;border-radius:12px;font-size:14px;font-weight:700;' +
      'color:#14171c;cursor:pointer}' +
      '.ngr-side__close{display:block;position:sticky;top:0;z-index:5;width:100%;margin:0 0 8px;' +
      'padding:13px;border:0;border-radius:12px;' +
      'background:#4984c4;color:#fff;font-size:15px;font-weight:700;cursor:pointer}}' +
      '@media(min-width:861px){.ngr-side__close{display:none}}';
    document.head.appendChild(st);
  }

  function sideGroup(title) {
    var g = document.createElement('div');
    g.className = 'ngr-side__g';
    g.setAttribute('data-g', title);
    g.innerHTML = '<div class="ngr-side__t"></div>';
    g.querySelector('.ngr-side__t').textContent = title;
    return g;
  }

  /**
   * КОЛОНКА ФИЛЬТРОВ ПОКА ВЫКЛЮЧЕНА (08.08).
   *
   * Tilda отдаёт варианты фильтра в разметку только когда список раскрыт,
   * поэтому колонка собиралась с одним пунктом в каждой группе — хуже, чем
   * прежняя строка фильтров (замечание Александра). Правильный путь: брать
   * полные списки значений из справочника фильтров Tilda, а нажимать —
   * её же флажки. Это следующая работа.
   */
  var SIDE_FILTERS = true;

  /*
   * Фильтр предлагает только то, что можно купить.
   *
   * Tilda считает значения по всему каталогу, включая товары без остатка:
   * у California Gold Nutrition она показывала 81 позицию, хотя на складе
   * нет ни одной. Покупатель выбирал бренд и попадал на пустую витрину
   * (замечание Александра 08.08). Список доступных значений считает воркер
   * по живым остаткам, здесь мы его только применяем.
   */
  var FACETS = null;        // null — ещё не спрашивали, {} — не дождались
  var facetsAsked = false;

  // Страну «Россия» не показываем: её проставили по ошибке в карточках Ozon,
  // товар на деле привозной (решение Александра 08.08).
  var HIDE_OPT = { 'Страна-изготовитель': { 'Россия': 1 } };

  function loadFacets(after) {
    if (facetsAsked) return;
    facetsAsked = true;
    fetch(API + '/catalog/facets')
      .then(function (r) { return r.json(); })
      .then(function (j) { FACETS = (j && j.groups) || {}; if (after) after(); })
      .catch(function () { FACETS = {}; if (after) after(); });
  }

  // Есть ли товар с таким значением. Про незнакомую группу не спорим:
  // лучше показать лишнее, чем спрятать нужное.
  function optAvailable(group, value) {
    if ((HIDE_OPT[group] || {})[value]) return false;
    if (!FACETS) return true;
    var box = FACETS[group];
    if (!box) return true;
    return !!box[value];
  }

  /**
   * Флажок фильтра ищем в момент нажатия, а не при сборке колонки.
   * Tilda перерисовывает разметку фильтра после каждого применения, и
   * запомненные ссылки повисали в воздухе: галочка в колонке ставилась,
   * а каталог не менялся (замечание Александра 08.08).
   */
  function liveOpt(group, value) {
    var items = [].slice.call(document.querySelectorAll('.t-catalog__filter__item'));
    for (var i = 0; i < items.length; i++) {
      var t = ((items[i].querySelector('.t-catalog__filter__item-title') || {}).textContent || '').trim();
      if (t !== group) continue;
      var labs = [].slice.call(items[i].querySelectorAll('label.t-checkbox__control'));
      for (var k = 0; k < labs.length; k++) {
        if ((labs[k].textContent || '').trim() === value) return labs[k];
      }
    }
    return null;
  }

  function liveNums(group) {
    var items = [].slice.call(document.querySelectorAll('.t-catalog__filter__item'));
    for (var i = 0; i < items.length; i++) {
      var t = ((items[i].querySelector('.t-catalog__filter__item-title') || {}).textContent || '').trim();
      if (t === group) return [].slice.call(items[i].querySelectorAll('input[type="text"], input[type="number"]'));
    }
    return [];
  }

  /**
   * Сверяем колонку с настоящим состоянием фильтра и заново прячем строку
   * Tilda: после перерисовки она возвращается на место, и покупатель видел
   * два фильтра сразу. Значения, которых в текущей выборке уже нет,
   * приглушаем — как на Ozon.
   */
  function syncSideFilters() {
    var side = document.querySelector('.ngr-side');
    if (!side) { document.documentElement.classList.remove('ngr-side-lock'); return; }
    if (!side.classList.contains('ngr-side_open')) document.documentElement.classList.remove('ngr-side-lock');
    side.querySelectorAll('.ngr-side__o').forEach(function (row) {
      var lab = liveOpt(row.getAttribute('data-g'), row.getAttribute('data-v'));
      var inp = lab && lab.querySelector('input');
      var next = 'ngr-side__o' + (inp && inp.checked ? ' on' : '') + (lab ? '' : ' off');
      // Пишем только при настоящем изменении. Замер 13.08: проход переписывал
      // класс всем 74 строкам колонки, и переписывал тем же самым значением —
      // 74 пересчёта стиля на каждый вызов, на видимой колонке. Это и есть
      // «скачут фильтры» при вводе в поиск (замечание Александра 13.08).
      if (row.className !== next) row.className = next;
    });
    // Строку фильтров Tilda (она повторяет список выбора справа от поиска и
    // закрывается от любого щелчка мимо — замечание Александра 09.08) раньше
    // прятали здесь, инлайном, на каждом проходе. Это и был мигающий фильтр:
    // Tilda перерисовывает строку, кадр она видна, следующий проход её гасит.
    // Теперь строка скрыта правилом в таблице стилей — оно действует в тот же
    // миг, когда узел вставлен, и проходу тут делать нечего.
    // См. .t-catalog__filter__item и .t-catalog__filter__options в filterBarCss.
    // Кнопка фильтров должна быть одна: лишние остаются от прежних сборок.
    var btns = document.querySelectorAll('.ngr-sidebtn');
    for (var b = 0; b < btns.length - 1; b++) btns[b].remove();
    var host = side.parentNode;
    if (host && !host.classList.contains('ngr-withside')) host.classList.add('ngr-withside');
  }

  /**
   * Ссылка с сортировкой в адресе (её выдаёт сама Tilda, когда покупатель
   * делится страницей) грузила восемь товаров вместо полутора сотен: первая
   * загрузка каталога идёт другим путём, и отрисовка обрывается. Лечим
   * тем же способом, каким сортировку меняет покупатель, — один раз, когда
   * каталог отрисован скудно (замечание Александра 08.08).
   */
  var wantSort = '';
  var sortApplied = false;

  /**
   * Сортировку из адреса Tilda применяет на первой загрузке каталога — и
   * рисует горстку товаров: без наших поправок по такой ссылке было четыре
   * карточки, с ними шесть, тогда как со страницы та же сортировка даёт
   * полторы сотни. Поэтому сортировку из адреса вынимаем до того, как Tilda
   * его прочитает, и применяем её потом обычным способом — списком выбора.
   */
  function takeUrlSort() {
    var m = location.search.match(/tfc_sort(?:%5B|\[)\d+(?:%5D|\])=([^&]+)/);
    if (!m) return;
    wantSort = decodeURIComponent(m[1]);
    var clean = location.search.replace(/tfc_sort(?:%5B|\[)\d+(?:%5D|\])=[^&]*/, '')
      .replace(/&&+/g, '&').replace(/[?&]$/, '').replace(/^&/, '?');
    if (clean === '?') clean = '';
    try { history.replaceState(null, '', location.pathname + clean + location.hash); } catch (e) {}
  }
  takeUrlSort();

  function fixUrlSort() {
    if (sortApplied || !wantSort) return;
    var sel = document.querySelector('#rec2502703571 select, .t-catalog select');
    if (!sel) return;
    if (!document.querySelectorAll('#rec2502703571 .js-product').length) return;
    var has = false;
    [].slice.call(sel.options).forEach(function (o) { if (o.value === wantSort) has = true; });
    if (!has) { sortApplied = true; return; }
    sortApplied = true;
    sel.value = wantSort;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Колонка фильтров — только в каталоге. На главной должна оставаться
  // витрина «В наличии сейчас» без фильтра (решение Александра 08.08).
  function onCatalogPage() {
    // Каталог живёт по трём адресам: отдельной страницей /catalog-new,
    // якорем на главной и признаком catalog= в адресе.
    return /catalog-new/.test(location.pathname) ||
      /[?&]catalog=/.test(location.search) || /ngr-catalog/.test(location.hash);
  }

  function buildSideFilters() {
    if (!SIDE_FILTERS || !onCatalogPage()) return;
    var bar = document.querySelector('.t-catalog__filter');
    if (!bar) return;
    // Без списка доступных значений колонку не собираем: иначе она мигнёт
    // полным перечнем и тут же перестроится.
    if (!FACETS) { loadFacets(buildSideFilters); return; }
    var block = document.querySelector('#rec2502703571 .js-catalog-cont-w-filter, #rec2502703571 .t-catalog');
    if (!block || block.querySelector('.ngr-side')) return;
    var items = [].slice.call(document.querySelectorAll('.t-catalog__filter__item'));
    if (items.length < 3) return;
    sideCss();

    var side = document.createElement('aside');
    side.className = 'ngr-side';
    side.setAttribute('role', 'dialog');
    side.setAttribute('aria-label', 'Фильтры каталога');

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'ngr-side__close';
    close.textContent = 'Показать товары';
    close.addEventListener('click', closeSideFilters);
    side.appendChild(close);

    items.forEach(function (it) {
      var title = ((it.querySelector('.t-catalog__filter__item-title') || {}).textContent || '').trim();
      if (!title || /сортировка/i.test(title)) return;
      // «Только товары в наличии» включено всегда — выбирать нечего.
      if (/наличие/i.test(title)) return;
      // Варианты фильтра лежат в разметке как label — контейнер один на всю
      // группу, и раньше колонка собиралась с одним пунктом (замечание
      // Александра 08.08).
      var opts = [].slice.call(it.querySelectorAll('label.t-checkbox__control'));
      var range = it.querySelector('input[type="range"], input[name="price_range"]');

      // Цена — два поля «от» и «до», связанные с полями Tilda.
      if (range || /цена/i.test(title)) {
        var nums = [].slice.call(it.querySelectorAll('input[type="text"], input[type="number"]'));
        if (nums.length < 2) return;
        var g = sideGroup(title);
        var row = document.createElement('div');
        row.className = 'ngr-side__price';
        row.innerHTML = '<input inputmode="numeric" placeholder="от"><span>—</span><input inputmode="numeric" placeholder="до">';
        var mine = row.querySelectorAll('input');
        mine[0].value = nums[0].value; mine[1].value = nums[1].value;
        [0, 1].forEach(function (k) {
          mine[k].addEventListener('change', function () {
            var live = liveNums(title);
            if (!live[k]) return;
            live[k].value = mine[k].value;
            live[k].dispatchEvent(new Event('input', { bubbles: true }));
            live[k].dispatchEvent(new Event('change', { bubbles: true }));
          });
        });
        g.appendChild(row);
        side.appendChild(g);
        return;
      }

      if (!opts.length) return;
      var g2 = sideGroup(title);
      var shown = 0;
      var i = -1;
      opts.forEach(function (o) {
        var inp = o.querySelector('input[type="checkbox"], input[type="radio"]');
        var text = (o.textContent || '').trim();
        if (!inp || !text) return;
        if (!optAvailable(title, text)) return;
        i++;
        var row = document.createElement('div');
        row.className = 'ngr-side__o' + (inp.checked ? ' on' : '');
        var logo = BRAND_LOGO[text];
        row.innerHTML = '<span class="ngr-side__box">✓</span>' +
          (logo ? '<span class="ngr-side__logo" style="background-image:url(' + LOGOS + logo + ')"></span>' : '') +
          '<span class="ngr-side__lbl"></span>';
        row.querySelector('.ngr-side__lbl').textContent = text;
        if (i >= 8) { row.setAttribute('data-extra', '1'); row.style.display = 'none'; }
        row.setAttribute('data-g', title);
        row.setAttribute('data-v', text);
        row.addEventListener('click', function () {
          var lab = liveOpt(title, text);
          if (!lab) return;                 // значения нет в текущей выборке
          lab.click();
          setTimeout(syncSideFilters, 400);
          setTimeout(syncSideFilters, 1500);
        });
        g2.appendChild(row);
        shown++;
      });
      if (shown > 8) {
        var more = document.createElement('span');
        more.className = 'ngr-side__more';
        more.textContent = 'Показать все';
        more.addEventListener('click', function () {
          var hidden = g2.querySelectorAll('[data-extra]');
          var open = more.textContent !== 'Показать все';
          hidden.forEach(function (h) { h.style.display = open ? 'none' : ''; });
          more.textContent = open ? 'Показать все' : 'Свернуть';
        });
        g2.appendChild(more);
      }
      side.appendChild(g2);
    });

    if (!side.children.length) return;

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ngr-side__reset';
    reset.textContent = 'Сбросить фильтры';
    reset.addEventListener('click', function () {
      document.querySelectorAll('.t-catalog__filter__item input:checked').forEach(function (i) {
        var lab = i.closest('label');
        if (lab) lab.click(); else i.click();
      });
      setTimeout(syncSideFilters, 400);
      setTimeout(syncSideFilters, 1500);
    });
    side.appendChild(reset);

    // Колонка длинная: спустившись к странам, листать обратно неудобно
    // (замечание Александра 09.08).
    var up = document.createElement('button');
    up.type = 'button';
    up.className = 'ngr-side__up';
    up.title = 'Наверх';
    up.textContent = '↑';
    up.addEventListener('click', function () { side.scrollTo({ top: 0, behavior: 'smooth' }); });
    side.addEventListener('scroll', function () {
      up.classList.toggle('on', side.scrollTop > 260);
    });
    side.appendChild(up);

    // Ставим колонку слева от сетки товаров.
    var grid = block.querySelector('.t-catalog__products, .js-catalog-products') ||
      (document.querySelector('.js-product') || {}).parentNode;
    if (!grid) return;
    var host = grid.parentNode;
    host.classList.add('ngr-withside');
    host.insertBefore(side, grid);

    // На телефоне колонка открывается кнопкой.
    // Колонка пересобирается, когда Tilda перерисовывает каталог, а кнопка
    // оставалась от прежней и открывала снятую со страницы колонку —
    // на телефоне фильтры не открывались вовсе (замечание Александра 08.08).
    document.querySelectorAll('.ngr-sidebtn').forEach(function (b) { b.remove(); });
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ngr-sidebtn';
    btn.textContent = '☰ Фильтры';
    btn.addEventListener('click', function () {
      openSideFilters(btn);
    });
    host.parentNode.insertBefore(btn, host);

    // Старую строку фильтров прячем целиком — поиск и выбор сортировки
    // живут отдельно, справа, и остаются на месте.
    document.querySelectorAll('.t-catalog__filter__item').forEach(function (it) {
      it.style.setProperty('display', 'none', 'important');
    });
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
      '.ngr-galimg{position:absolute;inset:0;background:transparent center/contain no-repeat;'+
      'opacity:0;transition:opacity .12s;pointer-events:none;z-index:2}' +
      '.ngr-gal{position:absolute;left:0;right:0;bottom:8px;display:flex;gap:5px;' +
      'justify-content:center;z-index:3;pointer-events:auto}' +
      '.ngr-gal b{width:22px;height:4px;border-radius:3px;background:rgba(20,23,28,.22);cursor:pointer;transition:background .15s}' +
      '.ngr-gal b.on{background:#ff7a1a}' +
      '.ngr-gal b:hover{background:rgba(20,23,28,.45)}' +
      /*
       * На телефоне точки не нажимались (замечание Александра 17.08).
       * Полоска высотой 5 точек — это не палец: нажатие попадало мимо и
       * открывало карточку товара. Растим только область касания: сверху и
       * снизу добавляем прозрачные поля, а сама полоска рисуется по
       * содержимому — на вид ничего не меняется.
       */
      '@media(max-width:960px){.ngr-gal{bottom:0;padding:0 0 6px}' +
      '.ngr-gal b{width:30px;height:5px;padding:11px 0;background-clip:content-box}}';
    document.head.appendChild(st);
  }

  var photoCache = {};

  /**
   * Галерея как на маркетплейсах: все фото товара, точки под снимком,
   * переключение наведением. Подмену вторым фото от Tilda выключаем совсем —
   * именно она давала серый экран (замечание Александра 07.08). Фото берём
   * из Ozon через интегратор, для открытого товара и один раз.
   */
  /**
   * Карусель фотографий в карточке каталога — как на маркетплейсах.
   *
   * Прошлые попытки подменяли фон карточки, спорили с ленивой загрузкой
   * Tilda и оставляли покупателя с размытыми заглушками. Теперь фон Tilda
   * не трогаем вовсе: рисуем СВОЙ слой поверх и показываем его только когда
   * покупатель выбрал не первый кадр. Первый кадр — всегда фото Tilda,
   * значит пустой карточка стать не может.
   */
  var NGR_GALLERY_ON = true;   // карусель в каталоге

  function buildGallery(card, photos) {
    var layers = [].slice.call(card.querySelectorAll('.t-catalog__card__bgimg'));
    if (!layers.length || !photos.length) return false;
    var wrap = layers[0].parentNode;
    if (!wrap || wrap.querySelector('.ngr-gal')) return true;

    galleryCss();
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';

    // Свой слой поверх фотографии Tilda.
    var over = document.createElement('div');
    over.className = 'ngr-galimg';
    wrap.appendChild(over);

    var frames = photos.slice(0, 5);          // 0 — фото Tilda, дальше Ozon
    var gal = document.createElement('div');
    gal.className = 'ngr-gal';
    gal.innerHTML = '<b class="on"></b>' + frames.map(function () { return '<b></b>'; }).join('');
    var dots = [].slice.call(gal.querySelectorAll('b'));

    var loaded = false;
    function preload() {
      if (loaded) return;
      loaded = true;
      frames.forEach(function (u) { var im = new Image(); im.src = u; });
    }

    var ready = {};

    function show(i) {
      dots.forEach(function (d, k) { d.className = k === i ? 'on' : ''; });
      if (i === 0) { over.style.opacity = '0'; return; }
      var url = frames[i - 1];
      // Слой показываем ТОЛЬКО когда снимок уже загружен. Раньше он
      // появлялся сразу и, пока фото ехало, покупатель видел пустой
      // прямоугольник вместо товара (замечание Александра 08.08).
      if (ready[url]) {
        over.style.backgroundImage = 'url("' + url + '")';
        over.style.opacity = '1';
        return;
      }
      var im = new Image();
      im.onload = function () {
        ready[url] = 1;
        // За время загрузки покупатель мог увести курсор — проверяем,
        // что этот кадр всё ещё выбран.
        if (dots[i] && dots[i].className === 'on') {
          over.style.backgroundImage = 'url("' + url + '")';
          over.style.opacity = '1';
        }
      };
      im.onerror = function () { over.style.opacity = '0'; };
      im.src = url;
    }

    dots.forEach(function (d, i) {
      d.addEventListener('mouseenter', function () { preload(); show(i); });
      d.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); preload(); show(i); });
      /*
       * Касание — отдельно от нажатия.
       *
       * На телефоне палец до `click` успевал открыть карточку товара: её
       * обработчик срабатывает раньше. Поэтому переключаем кадр уже на
       * `touchstart` и глушим событие, чтобы карточка не открывалась.
       */
      d.addEventListener('touchstart', function (e) {
        e.preventDefault();
        e.stopPropagation();
        preload();
        show(i);
      }, { passive: false });
    });
    wrap.addEventListener('mouseenter', preload);
    wrap.addEventListener('mouseleave', function () { show(0); });

    /*
     * Листание фотографии пальцем.
     *
     * Точки остаются, но целиться в них на ходу неудобно; смахивание по
     * снимку — то, чего покупатель ждёт от телефона. Порог 30 точек, чтобы
     * не спутать смахивание с нажатием, и по вертикали не мешаем прокрутке
     * страницы.
     */
    var текущий = 0;
    var сX = 0, сY = 0, следим = false;
    wrap.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { следим = false; return; }
      сX = e.touches[0].clientX;
      сY = e.touches[0].clientY;
      следим = true;
      preload();
    }, { passive: true });
    wrap.addEventListener('touchend', function (e) {
      if (!следим) return;
      следим = false;
      var т = e.changedTouches && e.changedTouches[0];
      if (!т) return;
      var dx = т.clientX - сX, dy = т.clientY - сY;
      if (Math.abs(dx) < 30 || Math.abs(dx) < Math.abs(dy)) return;   // это не смахивание
      e.preventDefault();
      e.stopPropagation();
      var к = текущий + (dx < 0 ? 1 : -1);
      if (к < 0) к = dots.length - 1;
      if (к > dots.length - 1) к = 0;
      текущий = к;
      show(к);
    }, { passive: false });

    // Точки тоже двигают запомненный кадр, иначе смахивание после нажатия
    // продолжало бы отсчёт с прежнего места.
    dots.forEach(function (d, i) {
      d.addEventListener('click', function () { текущий = i; });
      d.addEventListener('touchstart', function () { текущий = i; }, { passive: true });
    });

    wrap.appendChild(gal);
    return true;
  }

  /*
   * Серая карточка вместо фотографии.
   *
   * Замечание Александра 17.08: «на веб-версии первая картинка серая, как
   * будто что-то не прогружает». Замер объяснил: Tilda ставит в фон заглушку
   * шириной 20 точек, а настоящий снимок держит в `data-original` и подменяет
   * его лениво, когда карточка подъезжает к экрану. Заглушка 15×20, растянутая
   * по рамке, и выглядит как серый прямоугольник.
   *
   * Почему до некоторых карточек не доезжает: список каталога перерисовывается
   * (в том числе нашим подмешиванием товаров), и ленивый загрузчик успевает
   * пройти до появления новых узлов. Поэтому сначала просим его пройти ещё
   * раз, а те карточки, что уже на виду, дотягиваем сами.
   *
   * Осторожность: подменяем фон только после того, как снимок действительно
   * загрузился, иначе покупатель увидит пустоту вместо хотя бы заглушки.
   */
  function дотянутьФото() {
    try { if (typeof window.t_lazyload_update === 'function') window.t_lazyload_update(); } catch (e) {}
    document.querySelectorAll('.t-catalog__card__bgimg[data-original]').forEach(function (e) {
      var ор = e.getAttribute('data-original');
      if (!ор) return;
      if (String(e.style.backgroundImage || '').indexOf(ор) > -1) return;   // уже настоящий
      if (e.getAttribute('data-ngr-photo') === '1') return;
      var r = e.getBoundingClientRect();
      // Далёкие карточки не трогаем: их дотянет ленивый загрузчик, а мы не
      // будем тащить шестьсот снимков разом.
      if (r.bottom < -300 || r.top > window.innerHeight + 600) return;
      e.setAttribute('data-ngr-photo', '1');
      var im = new Image();
      im.onload = function () { e.style.backgroundImage = 'url("' + ор + '")'; };
      im.onerror = function () { e.removeAttribute('data-ngr-photo'); };
      im.src = ор;
    });
  }

  function fixCardPhotos() {
    if (!NGR_GALLERY_ON) { guardHoverPhoto(); return; }
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

  /*
   * Описание приходит с разметкой внутри текста.
   *
   * В карточках Ozon состав и эффекты оформлены списками, но до нас они
   * доезжают не разметкой, а буквами: покупатель читал «84% гидролизованного
   * куриного белка</li><li>9403 мг…» (замечание Александра 16.08).
   *
   * Разбираем сами и строим настоящие абзацы и списки. Разметку из текста
   * не вставляем ни при каких условиях: описание пишет поставщик, и всё,
   * что мы из него берём, попадает на страницу только как текст.
   */
  function разобратьОписание(сырое) {
    var s = String(сырое || '');
    // Мнемоники: их тоже показывали как есть.
    s = s.replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/&laquo;/gi, '«').replace(/&raquo;/gi, '»').replace(/&mdash;/gi, '—')
      .replace(/&ndash;/gi, '–').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
    if (!/<\/?(ul|ol|li|p|br|div|b|strong|i|em|h[1-6])\b[^>]*>/i.test(s)) return null;

    var блоки = [];
    var список = null;
    // Режем по значимым тегам, остальные просто выкидываем.
    var куски = s.split(/(<\/?(?:ul|ol|li|p|br|div|h[1-6])[^>]*>)/i);
    var текущий = '';

    function слить() {
      var v = текущий.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      текущий = '';
      return v;
    }
    function закрытьАбзац() {
      var v = слить();
      if (v) блоки.push({ вид: 'абзац', текст: v });
    }
    function закрытьПункт() {
      var v = слить();
      if (!v) return;
      if (!список) { список = { вид: 'список', пункты: [] }; блоки.push(список); }
      список.пункты.push(v);
    }

    куски.forEach(function (к) {
      var тег = /^<\/?([a-z0-9]+)/i.exec(к);
      if (!тег) { текущий += к; return; }
      var имя = тег[1].toLowerCase();
      var закрывающий = к.charAt(1) === '/';
      if (имя === 'li') {
        if (закрывающий) закрытьПункт();
        else { закрытьАбзац(); }
        return;
      }
      if (имя === 'ul' || имя === 'ol') {
        if (закрывающий) { закрытьПункт(); список = null; }
        else закрытьАбзац();
        return;
      }
      // p, br, div, заголовки — конец абзаца
      if (список) { закрытьПункт(); }
      else закрытьАбзац();
    });
    if (список) закрытьПункт(); else закрытьАбзац();

    return блоки.filter(function (б) {
      return б.вид === 'абзац' ? б.текст.length > 0 : б.пункты.length > 0;
    });
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
      var блоки = разобратьОписание(body);
      if (блоки && блоки.length) {
        блоки.forEach(function (б) {
          if (б.вид === 'список') {
            var ul = document.createElement('ul');
            ul.className = 'ngr-desclist';
            б.пункты.forEach(function (п) {
              var li = document.createElement('li');
              li.textContent = п;     // текст, а не разметка
              ul.appendChild(li);
            });
            b1.appendChild(ul);
            return;
          }
          var el3 = document.createElement('p');
          el3.textContent = б.текст;
          b1.appendChild(el3);
        });
      } else {
        body.split('\n\n').forEach(function (p) {
          var el2 = document.createElement('p');
          el2.textContent = p;          // текст, а не разметка
          b1.appendChild(el2);
        });
      }
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

  /*
   * ОТЗЫВЫ НАШИХ ПОКУПАТЕЛЕЙ
   *
   * Решение Александра 16.08, вариант А: писать отзыв вправе только тот,
   * кто купил товар, и только после того, как заказ получен. Право не
   * хранится флагом — сервер каждый раз выводит его из заказов покупателя,
   * подделать нечего.
   *
   * Список «что мне можно оценить» спрашиваем один раз на загрузку страницы:
   * серверу он стоит перебора заказов, и дёргать его на каждую открытую
   * карточку было бы расточительно.
   */
  var своиОтзывы = {};        // артикул → наши отзывы о товаре
  var правоНаОтзыв = null;    // список товаров, которые покупатель может оценить
  var правоЖдёт = null;

  function правоНаОтзывы() {
    if (правоНаОтзыв) return Promise.resolve(правоНаОтзыв);
    if (правоЖдёт) return правоЖдёт;
    if (!memberToken()) return Promise.resolve([]);
    правоЖдёт = подготовитьПредъявление().then(function () {
      return accountPost('can', {}, null, '/reviews/can');
    }).then(function (j) {
      if (j && j.pass) запомнитьПропуск(j.pass);
      правоНаОтзыв = (j && Array.isArray(j.items)) ? j.items : [];
      return правоНаОтзыв;
    }).catch(function () { return []; });
    return правоЖдёт;
  }

  function нашиОтзывы(sku) {
    if (своиОтзывы[sku]) return Promise.resolve(своиОтзывы[sku]);
    return fetch(API + '/reviews/own?sku=' + encodeURIComponent(sku))
      .then(function (x) { return x.json(); })
      .then(function (j) {
        своиОтзывы[sku] = (j && Array.isArray(j.list)) ? j.list : [];
        return своиОтзывы[sku];
      })
      .catch(function () { return []; });
  }

  /**
   * Снимок к отзыву уменьшаем прямо в браузере.
   *
   * С телефона приходят снимки по пять мегабайт: гнать их на сервер незачем
   * и долго. Ужимаем до 1280 точек по длинной стороне и, если всё ещё
   * тяжело, понижаем качество, пока не уложимся.
   */
  function сжатьСнимок(файл) {
    return new Promise(function (готово, беда) {
      if (!/^image\//.test(файл.type)) { беда(new Error('это не изображение')); return; }
      if (файл.size > 20 * 1024 * 1024) { беда(new Error('снимок больше 20 МБ')); return; }
      var rd = new FileReader();
      rd.onerror = function () { беда(new Error('не удалось прочитать файл')); };
      rd.onload = function () {
        var im = new Image();
        im.onerror = function () { беда(new Error('не удалось открыть снимок')); };
        im.onload = function () {
          var предел = 1280;
          var данные = '';
          function вес(d) { return d.length - d.indexOf(',') - 1; }
          /*
           * 300 Кб — предел, который принимает сервер.
           *
           * Сначала жертвуем качеством, а если и на низком не уложились
           * (так бывает с пёстрыми снимками), уменьшаем сам размер. Иначе
           * человек получил бы отказ уже после того, как всё написал.
           */
          for (var шаг = 0; шаг < 4; шаг++) {
            var k = Math.min(1, предел / Math.max(im.width, im.height));
            var cv = document.createElement('canvas');
            cv.width = Math.max(1, Math.round(im.width * k));
            cv.height = Math.max(1, Math.round(im.height * k));
            cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
            var кач = 0.82;
            данные = cv.toDataURL('image/jpeg', кач);
            while (вес(данные) > 300000 && кач > 0.4) {
              кач -= 0.12;
              данные = cv.toDataURL('image/jpeg', кач);
            }
            if (вес(данные) <= 300000) break;
            предел = Math.round(предел * 0.75);
          }
          if (вес(данные) > 300000) { беда(new Error('снимок не удалось ужать, попробуйте другой')); return; }
          готово(данные);
        };
        im.src = rd.result;
      };
      rd.readAsDataURL(файл);
    });
  }

  /** Форма отзыва. Показываем только тому, кто вправе его оставить. */
  function формаОтзыва(box, sku, товар) {
    var снимки = [];
    var оценка = 0;
    var форма = document.createElement('div');
    форма.className = 'ngr-revown';
    форма.innerHTML =
      '<b>Оставьте отзыв о товаре</b>' +
      '<p>Вы получили этот заказ' + (товар && товар.at
        ? ' — ' + String(товар.at).slice(0, 10).split('-').reverse().join('.') : '') +
      '. Расскажите, как вам товар: это поможет другим покупателям выбрать.</p>' +
      '<div class="ngr-revstars" role="radiogroup" aria-label="Оценка"></div>' +
      '<textarea maxlength="2000" placeholder="Что понравилось, что нет. Необязательно."></textarea>' +
      '<div class="ngr-revfiles"><label>Добавить фото' +
      '<input type="file" accept="image/*" multiple style="display:none"></label></div>' +
      '<button type="button" class="ngr-revsend">Отправить отзыв</button>' +
      '<span class="ngr-revsaid"></span>' +
      '<div class="ngr-revfail" style="display:none"></div>';

    var звёзды = форма.querySelector('.ngr-revstars');
    for (var i = 1; i <= 5; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.setAttribute('aria-label', i + ' из 5');
      b.setAttribute('data-v', String(i));
      b.textContent = '★';
      звёзды.appendChild(b);
    }
    звёзды.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]');
      if (!b) return;
      оценка = Number(b.getAttribute('data-v'));
      [].forEach.call(звёзды.children, function (к) {
        к.setAttribute('aria-checked', Number(к.getAttribute('data-v')) <= оценка ? 'true' : 'false');
      });
    });

    var беда = форма.querySelector('.ngr-revfail');
    function сказать(текст) {
      беда.textContent = текст || '';
      беда.style.display = текст ? '' : 'none';
    }

    var полка = форма.querySelector('.ngr-revfiles');
    var поле = форма.querySelector('input[type=file]');
    поле.addEventListener('change', function () {
      var файлы = [].slice.call(поле.files || []);
      поле.value = '';
      файлы.forEach(function (ф) {
        if (снимки.length >= 3) { сказать('Больше трёх снимков не поместится.'); return; }
        сжатьСнимок(ф).then(function (данные) {
          if (снимки.length >= 3) return;
          снимки.push(данные);
          var t = document.createElement('div');
          t.className = 'ngr-revthumb';
          t.innerHTML = '<img alt="Снимок к отзыву"><button type="button" aria-label="Убрать">×</button>';
          t.querySelector('img').src = данные;
          t.querySelector('button').onclick = function () {
            var i = снимки.indexOf(данные);
            if (i > -1) снимки.splice(i, 1);
            t.remove();
            сказать('');
          };
          полка.insertBefore(t, полка.firstChild);
          сказать('');
        }).catch(function (e) { сказать(e.message || 'Со снимком не вышло.'); });
      });
    });

    var кнопка = форма.querySelector('.ngr-revsend');
    var итог = форма.querySelector('.ngr-revsaid');
    кнопка.addEventListener('click', function () {
      if (!оценка) { сказать('Поставьте оценку — без неё отзыв не отправить.'); return; }
      сказать('');
      кнопка.disabled = true;
      итог.textContent = 'Отправляем…';
      accountPost('add', {
        sku: String(sku),
        rating: оценка,
        text: (форма.querySelector('textarea').value || '').trim(),
        photos: снимки
      }, null, '/reviews/add').then(function (j) {
        if (j && j.pass) запомнитьПропуск(j.pass);
        if (!j || !j.ok) throw new Error((j && j.error) || 'не получилось');
        итог.textContent = '';
        // Отзыв уже на сервере — перечитываем список, чтобы человек
        // сразу увидел свой отзыв, а не поверил на слово.
        delete своиОтзывы[sku];
        правоНаОтзыв = (правоНаОтзыв || []).filter(function (т) { return т.sku !== String(sku); });
        форма.innerHTML = '<b>Спасибо, отзыв опубликован</b>' +
          '<p>Он виден всем покупателям на этой странице.</p>';
        fixPopupReviews(true);
      }).catch(function (e) {
        кнопка.disabled = false;
        итог.textContent = '';
        сказать(e.message === 'Failed to fetch'
          ? 'Не получилось отправить — проверьте связь.'
          : (e.message || 'Не получилось отправить отзыв.'));
      });
    });

    box.appendChild(форма);
  }

  var FIRST_SHOWN = 3;   // остальные — по кнопке, чтобы карточка не растягивалась

  function renderReviews(box, sku, data, наши, можноОценить) {
    наши = наши || [];
    var n = (data.n || 0) + наши.length;
    // Пустую карточку рисуем, только если и сказать нечего, и написать некому.
    if (!n && !можноОценить) { box.innerHTML = ''; return; }
    // Свои отзывы ставим первыми: они о том же товаре, но из нашего магазина,
    // и покупателю важнее увидеть их, чем перенесённые с Ozon.
    var list = наши.concat(data.list || []);
    var dist = [0, 0, 0, 0, 0];
    list.forEach(function (r) { if (r.r >= 1 && r.r <= 5) dist[r.r - 1]++; });
    var shown = list.length;
    /*
     * Средняя оценка. У Ozon она посчитана по всем оценкам, включая те,
     * где отзыв не написан, поэтому складываем взвешенно, а не по головам
     * показанных отзывов.
     */
    var суммаНаших = 0;
    наши.forEach(function (r) { суммаНаших += Number(r.r) || 0; });
    var средняя = n
      ? ((Number(data.avg) || 0) * (data.n || 0) + суммаНаших) / n
      : 0;

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
        '<div class="ngr-rev__top"><span class="ngr-rev__who"></span>' +
        (r.own ? '<span class="ngr-rev__own">Покупал у нас</span>' : '') +
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
      '<div class="ngr-revscore"><div class="ngr-revbig">' + средняя.toFixed(1) + '</div>' +
      '<div><div>' + stars(средняя) + '</div>' +
      '<div class="ngr-revcount">' + n + ' ' + plural(n, 'отзыв', 'отзыва', 'отзывов') + '</div></div></div>' +
      (shown ? '<div class="ngr-revbars">' + bars + '</div>' : '') + '</div>' + items +
      (hidden ? '<button type="button" class="ngr-revmore">Показать ещё ' + hidden + ' ' +
        plural(hidden, 'отзыв', 'отзыва', 'отзывов') + '</button>' : '') +
      (shown ? '' : '<div class="ngr-revnote">Покупатели поставили оценки, но не написали отзыв.</div>') +
      '<div class="ngr-revnote">' +
      (наши.length
        ? 'Отзывы с пометкой «Покупал у нас» оставили покупатели nutry-go.ru после получения ' +
          'заказа, остальные — покупатели Ozon. '
        : 'Оценки и отзывы оставили покупатели Ozon после получения заказа. ') +
      'Мы показываем их как есть и ничего не удаляем.</div>';

    // Текст отзыва и имя вставляем как текст, а не разметку: их пишут люди.
    var nodes = box.querySelectorAll('.ngr-rev__text');
    var имена = box.querySelectorAll('.ngr-rev__who');
    list.forEach(function (r, i) {
      if (nodes[i]) nodes[i].textContent = r.x || '';
      if (имена[i]) имена[i].textContent = r.own ? (r.who || 'Покупатель') : 'Покупатель Ozon';
    });

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

    if (можноОценить) формаОтзыва(box, sku, можноОценить);
  }

  /** Развёрнутая карточка товара: сводка, распределение оценок и тексты. */
  function fixPopupReviews(заново) {
    if (!rating || !skuOf) return;
    var pop = document.querySelector('.t-popup_show .t-catalog__prod-popup__container, ' +
      '.t-catalog__prod-popup__container, .t-store__prod-popup__container');
    if (!pop || !pop.getBoundingClientRect().width) return;
    var a = article(pop);
    if (!a) return;
    var sku = skuOf[a];
    var box = pop.querySelector('.ngr-revbox');
    if (box && !заново && box.getAttribute('data-sku') === String(sku)) return;
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
    box.innerHTML = '<h4>Отзывы покупателей</h4><div class="ngr-revnote">Загружаем…</div>';

    /*
     * Три источника сразу: оценки Ozon, наши собственные отзывы и право
     * этого покупателя оставить свой. Раньше блок вовсе не рисовался,
     * если у Ozon отзывов не было, — тогда на такой товар нельзя было бы
     * написать первый отзыв.
     */
    var r = rating[sku];
    var озон = (!r || !r[0])
      ? Promise.resolve({ n: 0, avg: 0, list: [] })
      : (texts[sku]
        ? Promise.resolve(texts[sku])
        : fetch(API + '/catalog/reviews?sku=' + encodeURIComponent(sku))
          .then(function (x) { return x.json(); })
          .then(function (j) { texts[sku] = j; return j; })
          .catch(function () { return { n: 0, avg: 0, list: [] }; }));

    Promise.all([озон, нашиОтзывы(sku), правоНаОтзывы()]).then(function (всё) {
      if (box.getAttribute('data-sku') !== String(sku)) return;
      var можно = (всё[2] || []).filter(function (т) { return String(т.sku) === String(sku); })[0];
      renderReviews(box, sku, всё[0] || { n: 0, avg: 0, list: [] }, всё[1] || [], можно || null);
    }).catch(function () { box.innerHTML = ''; });
  }

  /**
   * Заказ только для зарегистрированных (решение Александра 07.08).
   *
   * Держим проверку здесь, а не в виджете пунктов выдачи: тот включается
   * только на шаге с адресом, а запрет должен работать на всём оформлении.
   * Кнопку гасим и объясняем, почему, — молча запрещать нельзя.
   */
  /* ---------- Форма заказа переживает вход ---------- */

  /**
   * Заполненное покупателем не должно пропадать.
   *
   * Случай из жизни (замечание Александра 16.08): человек в корзине вводит
   * имя, телефон, почту, выбирает пункт выдачи — и упирается в требование
   * войти. Жмёт «зарегистрироваться», Tilda перезагружает страницу, и всё
   * введённое исчезает. Он уже вошёл, но обязан набирать заново — на этом
   * шаге и бросают заказ.
   *
   * Поэтому: сохраняем поля при вводе, возвращаем их после перезагрузки.
   * Храним недолго и только у покупателя в браузере; пароли, скрытые поля
   * и токены не трогаем.
   */
  var КЛЮЧ_ФОРМЫ = 'ngr_cart_form';
  var ЖИЗНЬ_ФОРМЫ = 2 * 60 * 60 * 1000;   // два часа: дольше заказ не оформляют

  /*
   * Сохраняем строго перечисленное, а не «всё подряд».
   *
   * Телефон у Tilda живёт в трёх полях сразу, и главное из них скрытое —
   * при отборе «только видимые» телефон терялся, а без него заказ бесполезен.
   * Служебные поля формы (имя формы, скрытая приманка для роботов) наоборот
   * попадали в сохранение зря. Поэтому список точный.
   */
  var ПОЛЯ_ЗАКАЗА = [
    'Name', 'Email', 'Phone',
    'tildaspec-phone-part[]', 'tildaspec-phone-part[]-iso',
    'city', 'delivery_type', 'address', 'text', 'comment'
  ];

  function поляФормы(f) {
    var список = [];
    ПОЛЯ_ЗАКАЗА.forEach(function (имя) {
      [].slice.call(f.querySelectorAll('[name="' + имя + '"]')).forEach(function (e) {
        if (e.type === 'password' || e.type === 'file') return;
        список.push(e);
      });
    });
    return список;
  }

  function сохранитьФорму() {
    var данные = {};
    cartForms().forEach(function (f) {
      поляФормы(f).forEach(function (e) {
        if (e.value) данные[e.name] = e.value;
      });
    });
    if (!Object.keys(данные).length) return;
    try {
      localStorage.setItem(КЛЮЧ_ФОРМЫ, JSON.stringify({ когда: Date.now(), поля: данные }));
    } catch (e) {}
  }

  function вернутьФорму() {
    var сохранённое;
    try { сохранённое = JSON.parse(localStorage.getItem(КЛЮЧ_ФОРМЫ) || 'null'); } catch (e) { return; }
    if (!сохранённое || !сохранённое.поля) return;
    if (Date.now() - (сохранённое.когда || 0) > ЖИЗНЬ_ФОРМЫ) {
      try { localStorage.removeItem(КЛЮЧ_ФОРМЫ); } catch (e) {}
      return;
    }
    var вернули = false;
    cartForms().forEach(function (f) {
      поляФормы(f).forEach(function (e) {
        // Заполняем только пустое: то, что покупатель уже набрал сейчас,
        // важнее сохранённого.
        if (e.value || !сохранённое.поля[e.name]) return;
        e.value = сохранённое.поля[e.name];
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        вернули = true;
      });
    });
    return вернули;
  }

  /**
   * Следим за вводом и возвращаем сохранённое, когда форма появится.
   * Форму Tilda пересобирает, поэтому обработчик вешаем на документ.
   */
  var формаНастроена = false;

  function держатьФорму() {
    if (!формаНастроена) {
      формаНастроена = true;
      var таймер = null;
      document.addEventListener('input', function (e) {
        var f = e.target && e.target.closest && e.target.closest(
          '.t-store__cart-form, .t706__cartwin form, form[name*="cart"]');
        if (!f) return;
        clearTimeout(таймер);
        таймер = setTimeout(сохранитьФорму, 400);
      }, true);
      // Уход на регистрацию — последний момент, когда можно сохранить.
      document.addEventListener('click', function (e) {
        var a = e.target && e.target.closest && e.target.closest('a[href*="openmembersbar"]');
        if (a) сохранитьФорму();
      }, true);
      // Заказ оформлен — сохранённое больше не нужно.
      document.addEventListener('submit', function (e) {
        var f = e.target;
        if (f && f.matches && f.matches('.t-store__cart-form, .t706__cartwin form, form[name*="cart"]')) {
          if (member()) { try { localStorage.removeItem(КЛЮЧ_ФОРМЫ); } catch (err) {} }
        }
      }, true);
    }
    вернутьФорму();
  }

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
        box.style.cssText = 'margin:0 0 16px;padding:16px 18px;border:1px solid #f0c9a3;' +
          'background:#fff7ef;border-radius:14px;color:#7a4a12;font-size:14px;line-height:1.5';
        box.innerHTML = '<b>Сначала войдите — это займёт минуту.</b><br>' +
          'Достаточно почты: пришлём код, и данные заказа подставятся сами. ' +
          'Заказ, документы и история покупок останутся у вас под рукой.<br>' +
          '<a href="#openmembersbar" style="display:inline-block;margin-top:10px;padding:11px 18px;' +
          'background:#ff7a1a;color:#fff;border-radius:10px;font-weight:700;text-decoration:none">' +
          'Войти или зарегистрироваться</a>' +
          '<div style="margin-top:8px;font-size:13px;color:#9a7550">' +
          'Уже заполненное не пропадёт — вернём после входа.</div>';
        /*
         * Плашка стоит ПЕРЕД полями, а не перед кнопкой оплаты.
         *
         * Раньше покупатель заполнял имя, телефон, почту, выбирал пункт
         * выдачи — и только внизу узнавал, что нужен вход. После входа
         * страница перезагружалась, и всё приходилось набирать заново
         * (замечание Александра 16.08). Просить вход надо до работы, а не
         * после неё.
         */
        f.insertBefore(box, f.firstChild);
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

  /*
   * Самопроверка аккаунта: nutry-go.ru/?ngr-check=1
   *
   * Кабинет открывается только под входом Александра, поэтому две вещи
   * я проверить не могу: переносится ли аватар на телефон (замечание
   * 16.08) и легли ли имя с телефоном из заказа в профиль на сервере.
   * Панель показывает ровно то, что вернул сервер и что лежит в браузере.
   * Достаточно открыть ссылку на компьютере и на телефоне и сравнить:
   * если строки совпали — перенос работает.
   *
   * Покупателям панель не видна: без флага в адресе она не рисуется,
   * и ничего никуда не записывает — только читает.
   */
  var самопроверкаИдёт = false;
  function самопроверка() {
    if (самопроверкаИдёт || location.search.indexOf('ngr-check=1') < 0) return;
    самопроверкаИдёт = true;

    var окно = document.createElement('div');
    окно.style.cssText = 'position:fixed;z-index:2147483000;left:12px;right:12px;bottom:12px;' +
      'max-width:560px;margin:0 auto;padding:16px 18px;border-radius:14px;' +
      'background:#fff;border:1px solid #dfe3e8;box-shadow:0 12px 40px rgba(0,0,0,.18);' +
      'font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'color:#222;max-height:80vh;overflow:auto;' +
      // Панель рождается, пока загрузочный стиль ещё прячет страницу,
      // а от Tilda ей достаётся transition: all. Переход тогда застревает
      // на скрытом состоянии, и панель не показывается. Задаём прямо.
      'visibility:visible!important;transition:none!important';
    окно.innerHTML = '<b>Самопроверка аккаунта</b><div class="ngr-chk__body">' +
      'Спрашиваем сервер…</div>' +
      '<button type="button" style="margin-top:12px;padding:9px 16px;border:0;border-radius:9px;' +
      'background:#ff7a1a;color:#fff;font-weight:700;cursor:pointer">Закрыть</button>';
    окно.querySelector('button').onclick = function () { окно.remove(); };
    document.body.appendChild(окно);
    var тело = окно.querySelector('.ngr-chk__body');

    function строка(имя, знач) {
      return '<div style="display:flex;gap:10px;padding:5px 0;border-bottom:1px solid #f0f2f5">' +
        '<span style="flex:0 0 46%;color:#6b7280">' + имя + '</span>' +
        '<b style="flex:1;word-break:break-word">' + (знач || '—') + '</b></div>';
    }
    var устройство = (window.innerWidth <= 640 ? 'телефон' : 'компьютер') +
      ', ширина ' + window.innerWidth;

    if (!memberToken()) {
      тело.innerHTML = строка('Устройство', устройство) +
        строка('Вход', 'не выполнен') +
        '<div style="margin-top:10px;color:#6b7280">Войдите в кабинет и откройте ссылку снова.</div>';
      return;
    }

    подготовитьПредъявление().then(function () {
      return accountPost('read', {});
    }).then(function (packet) {
      var s = (packet && packet.snapshot) || {};
      var p = s.profile || {};
      var м = profileSettings();
      тело.innerHTML =
        строка('Устройство', устройство) +
        строка('Аккаунт на сервере', s.subject ? 'узнан' : 'не узнан') +
        строка('Псевдоним', p.nick) +
        строка('Аватар', p.avatar) +
        строка('Фотография', p.photo ? 'загружена, ' + Math.round(p.photo.length / 1024) + ' Кб' : 'нет') +
        строка('Имя из заказа', p.name) +
        строка('Телефон из заказа', p.phone ? телефонДляГлаз(p.phone) : '') +
        строка('Избранное', String((s.favorites || []).length) + ' шт.') +
        строка('Версия записи', String(s.revision || 0)) +
        строка('Обновлено', s.updated) +
        строка('В браузере — аватар', м.avatar) +
        строка('В браузере — имя', м.name) +
        '<div class="ngr-chk__rev" style="padding:5px 0;color:#6b7280">Спрашиваем про отзывы…</div>' +
        '<div style="margin-top:10px;color:#6b7280">Строки «на сервере» должны совпасть ' +
        'на компьютере и на телефоне.</div>';

      // Отдельно — что сервер знает про заказы: без этого причину «отзыв
      // написать не могу» пришлось бы угадывать.
      accountPost('can', {}, null, '/reviews/can').then(function (о) {
        var м2 = тело.querySelector('.ngr-chk__rev');
        if (!м2) return;
        var с = (о && о.debug) || {};
        м2.outerHTML =
          строка('Заказов в наших записях', String(с.наших || 0)) +
          строка('Из них получено', String(с.полученныхНаших || 0)) +
          строка('Заказов видит у Tilda', String(с.уTilda || 0)) +
          строка('Из них получено', String(с.полученныхУTilda || 0)) +
          строка('Товаров можно оценить', String(((о && о.items) || []).length)) +
          строка('Уже оценено', String(((о && о.done) || []).length));
      }).catch(function (e2) {
        var м3 = тело.querySelector('.ngr-chk__rev');
        if (м3) м3.outerHTML = строка('Отзывы', 'ошибка: ' + ((e2 && e2.message) || e2));
      });
    }).catch(function (e) {
      тело.innerHTML = строка('Устройство', устройство) +
        строка('Ошибка', String((e && e.message) || e));
    });
  }

  function apply() {
    самопроверка();
    fixPopup(); fixCards(); fixCart(); fixPromocode(); fixDupDelivery(); fixUnits(); fixBrands();
    initSearchGuard(); fixSearch(); initSmartSearch(); fixAccountButton(); fixAuthGate(); держатьФорму(); faqCss(); меткаКорзины(); значокВкладки();
    fixRatings(); fixPopupReviews(); fixDescription(); fixDeliveryOrder(); fixCardPhotos(); fixPrices(); fixFilterValues(); fixRatingFilter(); applyRatingFilter(false); fixShelves(); fixSgr(); fixFav(); cartCss(); docsSearch(); filterBarCss(); trimFilterBar(); dropCartTip(); prefillCart(); pullProfileOnce(); buildSideFilters(); syncSideFilters(); fixUrlSort(); promoBtnCss(); мобильнаяКарточкаCss(); дотянутьФото();
  }

  apply();
  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', apply);
  // Tilda меняет каталог пачкой мутаций. Короткий debounce объединяет пачку,
  // но его общий max-deadline не переносится: непрерывная лента изменений
  // не может навсегда отложить apply и оставить старую inline-геометрию.
  var APPLY_DELAY = 40;
  var APPLY_MAX_WAIT = 180;
  var applyTimer = null;
  var applyMaxTimer = null;
  var applyPromptTimer = null;
  var applyPending = false;

  function runQueuedApply() {
    if (!applyPending) return;
    applyPending = false;
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    if (applyMaxTimer !== null) {
      clearTimeout(applyMaxTimer);
      applyMaxTimer = null;
    }
    if (applyPromptTimer !== null) {
      clearTimeout(applyPromptTimer);
      applyPromptTimer = null;
    }
    apply();
    // apply() сам меняет DOM: цены, классы карточек, ссылки, галереи. Эти
    // мутации видит наблюдатель ниже и снова ставит apply в очередь — проход
    // гонялся по кругу без остановки. Замер 13.08 на каталоге из 730 карточек:
    // 1208 мутаций в секунду непрерывно, из-за чего строку фильтров дёргало
    // примерно дважды в секунду (замечание Александра «скачет фильтр, это цикл»).
    // Забираем и выбрасываем записи, накопленные за время самого прохода:
    // чужие изменения, пришедшие после него, поставят apply в очередь как обычно.
    if (applyObserver) applyObserver.takeRecords();
    applyPending = false;
  }

  function queueApply(prompt) {
    applyPending = true;
    // Смена ширины должна сразу обновить inline-размеры, даже если обычный
    // mutation-проход уже стоит в очереди.
    // MutationObserver передаёт массив мутаций первым аргументом, поэтому
    // немедленный режим включается только явным boolean true от resize.
    if (prompt === true && applyPromptTimer === null) {
      applyPromptTimer = setTimeout(runQueuedApply, 0);
    }
    // Debounce объединяет короткую пачку, а hard max-wait не перезапускается:
    // непрерывные мутации не вызывают apply каждые 40 мс и не могут его заморить.
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
    }
    applyTimer = setTimeout(runQueuedApply, APPLY_DELAY);
    if (applyMaxTimer === null) {
      applyMaxTimer = setTimeout(runQueuedApply, APPLY_MAX_WAIT);
    }
  }
  // Наблюдатель держим в переменной: runQueuedApply гасит через него мутации,
  // которые породил сам apply, иначе проход будит сам себя по кругу.
  var applyObserver = new MutationObserver(queueApply);
  applyObserver.observe(document.documentElement, { childList: true, subtree: true });
  /*
   * Смена ширины окна больше не запускает полный проход.
   *
   * Замечание Александра 14.08: «когда работаю с окном, расширяю и сужаю —
   * пропала плавность адаптации, видно, что фризит и догоняет размер экрана
   * слишком медленно». Так и было: на каждое изменение ширины мы немедленно
   * гнали apply() по всем 730 карточкам — цены, наличие, рейтинги, галереи, —
   * и делали это десятки раз за одно перетаскивание края окна.
   *
   * Смысл в этом был, пока раскладку задавал JS инлайновыми размерами. Сегодня
   * её задают медиазапросы, а браузер применяет их сам и мгновенно. Осталась
   * одна мелочь, которой ширина ещё нужна, — метка страницы каталога; её и
   * ставим, с задержкой в четверть секунды после того, как человек отпустил
   * край окна.
   */
  var applyWidth = window.innerWidth;
  var ширинаТаймер = null;
  window.addEventListener('resize', function () {
    if (window.innerWidth === applyWidth) return;
    applyWidth = window.innerWidth;
    if (ширинаТаймер !== null) clearTimeout(ширинаТаймер);
    ширинаТаймер = setTimeout(function () {
      ширинаТаймер = null;
      try { trimFilterBar(); } catch (e) {}
    }, 250);
  }, { passive: true });
})();
