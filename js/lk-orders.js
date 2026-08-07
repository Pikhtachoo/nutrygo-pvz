/**
 * Личный кабинет nutry-go.ru: отмена и изменение заказа покупателем.
 *
 * Ozon отправляет покупателя за отменой «на сайт партнёра» — значит, кнопки
 * должны быть у нас. Скрипт добавляет в карточку заказа две кнопки:
 * «Отменить заказ» и «Изменить данные». Нажатие уходит в интегратор, тот
 * пробует отменить отправление в Ozon и уведомляет менеджера; возврат оплаты
 * подтверждает человек.
 *
 * Ставится блоком T123 на страницу личного кабинета.
 */
(function () {
  'use strict';

  var API = window.NG_INTEGRATOR ||
    'https://nutrygo-integrator.pikhtovnikov-alieksandr.workers.dev/order/request';

  var css = document.createElement('style');
  css.textContent =
    '.ngord{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0 4px}' +
    '.ngord__btn{border:1px solid #d9d9d9;background:#fff;border-radius:10px;padding:9px 16px;font-size:14px;cursor:pointer;color:#222}' +
    '.ngord__btn:hover{background:#f6f6f6}' +
    '.ngord__btn--danger{border-color:#f0c4c4;color:#b3261e}' +
    '.ngord__note{font-size:13px;color:#666;margin-top:8px;line-height:1.45}' +
    '.ngord__ok{color:#1f8a3b}' +
    '.ngord__form{margin-top:10px;display:none}' +
    '.ngord__form textarea{width:100%;min-height:70px;border:1px solid #ccc;border-radius:10px;padding:10px;font-size:14px;font-family:inherit}' +
    '.ngord_open .ngord__form{display:block}';
  document.head.appendChild(css);

  function findOrderInfo() {
    var text = document.body.innerText;
    var num = (text.match(/Заказ\s*№\s*(\d+)/i) || [])[1];
    var phone = (text.match(/(\+7[\s(]*\d{3}[\s)]*\d{3}[-\s]?\d{2}[-\s]?\d{2})/) || [])[1];
    var paid = /Оплачено|Оплачен/i.test(text);
    return { num: num, phone: phone, paid: paid };
  }

  function send(kind, info, text, done) {
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: kind,
        ext_id: info.num,
        phone: (info.phone || '').replace(/\D/g, ''),
        text: text || ''
      })
    }).then(function (r) { return r.json(); })
      .then(function (j) { done(j && j.message ? j.message : 'Заявка принята.'); })
      .catch(function () {
        done('Не удалось отправить заявку. Позвоните нам: 8 (977) 090-22-88.');
      });
  }

  function mount() {
    var info = findOrderInfo();
    if (!info.num) return;                       // не страница заказа
    if (document.querySelector('.ngord')) return; // уже добавлено

    // Ставим панель после блока с данными заказа
    var anchor = null;
    var blocks = document.querySelectorAll('div, section');
    for (var i = 0; i < blocks.length; i++) {
      var t = (blocks[i].textContent || '');
      if (/ДАННЫЕ/i.test(t) && t.length < 900 && blocks[i].getBoundingClientRect().width > 200) anchor = blocks[i];
    }
    if (!anchor) anchor = document.querySelector('main') || document.body;

    var box = document.createElement('div');
    box.className = 'ngord';
    box.innerHTML =
      '<button type="button" class="ngord__btn ngord__btn--danger" data-kind="cancel">Отменить заказ</button>' +
      '<button type="button" class="ngord__btn" data-kind="change">Изменить данные</button>' +
      '<div class="ngord__note" style="flex-basis:100%">' +
        'Отмена и изменение заказа — только через магазин: Ozon перенаправляет такие обращения нам.' +
      '</div>' +
      '<div class="ngord__form" style="flex-basis:100%">' +
        '<textarea placeholder="Что изменить: адрес пункта выдачи, телефон, состав заказа"></textarea>' +
        '<div style="margin-top:8px"><button type="button" class="ngord__btn" data-send="1">Отправить заявку</button></div>' +
      '</div>';
    anchor.parentNode.insertBefore(box, anchor.nextSibling);

    var note = box.querySelector('.ngord__note');
    var form = box.querySelector('.ngord__form');
    var pending = null;

    box.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;

      if (b.getAttribute('data-kind') === 'cancel') {
        if (!confirm('Отменить заказ № ' + info.num + '? Оплату вернём на ту же карту.')) return;
        b.disabled = true;
        send('cancel', info, '', function (msg) {
          note.textContent = msg;
          note.className = 'ngord__note ngord__ok';
        });
      }

      if (b.getAttribute('data-kind') === 'change') {
        box.classList.add('ngord_open');
        pending = 'change';
        form.querySelector('textarea').focus();
      }

      if (b.getAttribute('data-send')) {
        var txt = form.querySelector('textarea').value.trim();
        if (!txt) { form.querySelector('textarea').focus(); return; }
        b.disabled = true;
        send('change', info, txt, function (msg) {
          box.classList.remove('ngord_open');
          note.textContent = msg;
          note.className = 'ngord__note ngord__ok';
        });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', mount);
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  mount();
})();
