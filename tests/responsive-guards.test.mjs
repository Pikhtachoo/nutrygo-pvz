import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stock = await readFile(resolve(repoRoot, 'js/ngr-stock.js'), 'utf8');
const pvz = await readFile(resolve(repoRoot, 'js/pvz-picker.js'), 'utf8');

/**
 * The production scripts build CSS from adjacent JavaScript string literals.
 * This deliberately small scanner extracts those literal bodies without
 * executing storefront code in Node.
 */
function stringCorpus(source) {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const quote = source[i];
    if (quote !== "'" && quote !== '"') continue;
    for (i += 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '\\') {
        if (i + 1 < source.length) {
          out += source[i + 1];
          i += 1;
        }
        continue;
      }
      if (ch === quote) break;
      out += ch;
    }
  }
  return out;
}

function mediaBlocks(css) {
  const blocks = [];
  const re = /@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)\s*\{/g;
  let match;
  while ((match = re.exec(css))) {
    const start = re.lastIndex;
    let depth = 1;
    let i = start;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    blocks.push({ maxWidth: Number(match[1]), css: css.slice(start, i - 1) });
  }
  return blocks;
}

function cssAtMost(css, width) {
  return mediaBlocks(css)
    .filter((block) => block.maxWidth <= width)
    .map((block) => block.css)
    .join('\n');
}

function ruleBodies(css, selector) {
  const bodies = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css))) {
    if (match[1].includes(selector)) bodies.push(match[2]);
  }
  return bodies;
}

function pxAtMost(body, property, limit) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*(\\d+)px`, 'i'));
  return Boolean(match && Number(match[1]) <= limit);
}

function namedFunctionSource(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `Expected function ${name}() in storefront source.`);
  const brace = source.indexOf('{', match.index);
  let depth = 0;
  for (let i = brace; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  assert.fail(`Function ${name}() has no closing brace.`);
}

const stockCss = stringCorpus(stock);
const pvzCss = stringCorpus(pvz);

test('mobile cart control uses a non-obstructing geometry', () => {
  const mobile = cssAtMost(stockCss, 640);
  const rules = ruleBodies(mobile, '.t706__carticon');
  const safe = rules.some((body) => {
    const removedFromOverlay = /display\s*:\s*none\s*!important/i.test(body)
      || /position\s*:\s*(?:static|sticky)\s*!important/i.test(body);
    const compactOverlay = pxAtMost(body, 'width', 72)
      && pxAtMost(body, 'height', 72)
      && /box-sizing\s*:\s*border-box/i.test(body);
    return removedFromOverlay || compactOverlay;
  });

  assert.ok(
    safe,
    'At <=640px make .t706__carticon non-fixed/hidden, or cap it to <=72x72 with border-box so the 146px pill cannot cover product links.',
  );
});

test('mobile filters drawer has a reachable close lifecycle', () => {
  const tablet = cssAtMost(stockCss, 1000);
  const closeRules = ruleBodies(tablet, '.ngr-side__close');
  assert.ok(
    closeRules.some((body) => /position\s*:\s*sticky/i.test(body)
      && /top\s*:\s*(?:0|\d+px)/i.test(body)
      && /z-index\s*:/i.test(body)),
    'At <=1000px .ngr-side__close must be sticky at the top, not only after the 1420px filter list.',
  );

  assert.match(stock, /function\s+closeSideFilters\s*\(/,
    'Use one closeSideFilters() path for button, Escape, focus return and scroll unlock.');
  assert.match(stock, /keydown[\s\S]{0,500}Escape[\s\S]{0,500}closeSideFilters\s*\(/,
    'Escape must close the filters drawer.');
  assert.match(stock, /closeSideFilters[\s\S]{0,1200}\.focus\s*\(/,
    'Closing the drawer must return focus to its trigger.');
  assert.match(stock, /(?:document\.body|document\.documentElement)\.classList\.(?:add|toggle)\([\s\S]{0,120}(?:lock|open)/,
    'Opening the drawer must lock background scrolling with a body/html state class.');
  assert.match(stockCss, /\.(?:ngr-side-lock|ngr-side_opened|ngr-filters-open)[^{]*\{[^}]*overflow\s*:\s*hidden/i,
    'The drawer state class must apply overflow:hidden to the background page.');
});

test('mobile checkout auth action stays inside the cart viewport', () => {
  const mobile = cssAtMost(stockCss, 640);
  const authRules = ruleBodies(mobile, '.t706__auth');
  const logoutRules = ruleBodies(mobile, '.js-cart-log-out');

  assert.ok(authRules.some((body) => /display\s*:\s*flex/i.test(body)
    && /flex-wrap\s*:\s*wrap/i.test(body)),
  'At <=640px the .t706__auth row must wrap instead of pushing logout past x=360.');
  assert.ok(logoutRules.some((body) => /position\s*:\s*static/i.test(body)
    && /max-width\s*:\s*100%/i.test(body)
    && /box-sizing\s*:\s*border-box/i.test(body)),
  'At <=640px .js-cart-log-out must be static and capped to the auth row width.');
});

test('catalog toolbar has one deterministic 320-1000px layout', () => {
  const tablet = cssAtMost(stockCss, 1000);
  const rowRules = ruleBodies(tablet, '.t-catalog__filter__search-and-sort');
  const inputRules = ruleBodies(tablet, '.js-catalog-filter-search');
  const sortRules = ruleBodies(tablet, '.t-catalog__sort-select');

  assert.ok(rowRules.some((body) => /display\s*:\s*grid/i.test(body)
    && /grid-template-columns\s*:/i.test(body)
    && /width\s*:\s*100%/i.test(body)),
  'Use one full-width CSS grid for sort + search from 320 through 1000px.');
  assert.ok(inputRules.some((body) => /min-width\s*:\s*0/i.test(body)
    && /width\s*:\s*100%/i.test(body)),
  'Search must be width:100%; min-width:0 inside the responsive grid.');
  assert.ok(sortRules.some((body) => /min-width\s*:\s*0/i.test(body)
    && /width\s*:\s*100%/i.test(body)),
  'Sort must be width:100%; min-width:0 inside the responsive grid.');
  assert.doesNotMatch(stock,
    /ss\.style\.setProperty\(\s*['"]width['"]\s*,\s*['"]auto['"]\s*,\s*['"]important['"]\s*\)/,
    'An inline width:auto!important currently overrides the <=1000px toolbar rule; make width breakpoint-aware.',
  );
  assert.match(stockCss,
    /@media\(min-width:1001px\)\{[\s\S]{0,900}\.t-catalog__filter__sort\{[^}]*flex\s*:\s*0\s+0\s+210px[^}]*\}[\s\S]{0,300}\.t-catalog__filter__search\{[^}]*flex\s*:\s*0\s+0\s+260px/i,
    'Desktop sort/search wrappers need fixed flex bases so the search host cannot collapse to zero width.',
  );
  assert.match(stock, /поле\(q,\s*узко\s*\?\s*['"]100%['"]\s*:\s*['"]260px['"]\)/,
    'The inline desktop input width must equal the 260px search wrapper.');
  assert.doesNotMatch(stock, /поле\(q,[^\n]*['"]280px['"]/,
    'An inline 280px!important input protrudes from the 260px smart-search host.');
});

test('native filter chips cannot flash during search rerenders', () => {
  const chipRules = ruleBodies(stockCss,
    '#rec2502703571.ngr-catalog-record .t-catalog__filter__options > .t-catalog__filter__item');
  assert.ok(chipRules.some((body) => /display\s*:\s*none\s*!important/i.test(body)),
    'Native Tilda filter chips need a permanent record-scoped CSS hide, not delayed inline cleanup.');

  const optionRules = ruleBodies(stockCss,
    '#rec2502703571.ngr-catalog-record .t-catalog__filter__controls-wrapper > .t-catalog__filter__options');
  assert.ok(optionRules.some((body) => /display\s*:\s*none\s*!important/i.test(body)),
    'The native options row must stay out of layout while Tilda rebuilds the search DOM.');

  for (const selector of [
    '.js-catalog-filter-mob-btn',
    '.js-catalog-sort-mob-btn',
    '.js-catalog-search-mob-btn',
    '.js-catalog-search-mob-close-btn',
  ]) {
    const rules = ruleBodies(stockCss, `#rec2502703571 ${selector}`);
    assert.ok(rules.some((body) => /display\s*:\s*none\s*!important/i.test(body)),
      `${selector} must not re-open or duplicate the compact toolbar.`);
  }

  const barRules = ruleBodies(stockCss, '#rec2502703571 .t-catalog__filter');
  assert.ok(barRules.some((body) => /background\s*:\s*transparent\s*!important/i.test(body)
    && /padding\s*:\s*0\s*!important/i.test(body)),
  'The compact toolbar chrome must be invariant on both home and full-catalog URLs.');

  const smartInit = namedFunctionSource(stock, 'initSmartSearch');
  assert.doesNotMatch(smartInit, /if\s*\(\s*!onCatalogPage\(\)\s*\)\s*return/,
    'Description/typo search must initialize anywhere the catalog search input is present.');
});

test('compact filter hide selectors outrank the published record skin', () => {
  const optionsSelector = '#rec2502703571.ngr-catalog-record '
    + '.t-catalog__filter__controls-wrapper > .t-catalog__filter__options';
  const itemSelector = '#rec2502703571.ngr-catalog-record '
    + '.t-catalog__filter__options > .t-catalog__filter__item';

  for (const selector of [optionsSelector, itemSelector]) {
    const rules = ruleBodies(stockCss, selector);
    assert.ok(rules.some((body) => /display\s*:\s*none\s*!important/i.test(body)),
      `${selector} must beat the record-scoped display:flex!important rules in custom.css.`);
  }
});

test('mobile search font outranks the published record input skin', () => {
  const mobile = cssAtMost(stockCss, 600);
  const selector = '#rec2502703571.ngr-catalog-record input.js-catalog-filter-search';
  const rules = ruleBodies(mobile, selector);
  assert.ok(rules.some((body) => /font-size\s*:\s*16px\s*!important/i.test(body)),
    'The mobile search input must beat the 14px!important record skin and avoid iOS auto-zoom.');
});

test('catalog apply queue cannot starve and width changes bypass its delay', () => {
  const queue = namedFunctionSource(stock, 'queueApply');
  assert.match(queue,
    /if\s*\(\s*applyTimer\s*!==\s*null\s*\)[\s\S]*?clearTimeout\s*\(\s*applyTimer\s*\)[\s\S]*?setTimeout\s*\(\s*runQueuedApply\s*,\s*APPLY_DELAY\s*\)/,
    'The short debounce should coalesce a quiet mutation burst before applying.');
  assert.match(queue,
    /if\s*\(\s*applyMaxTimer\s*===\s*null\s*\)[\s\S]*?setTimeout\s*\(\s*runQueuedApply\s*,\s*APPLY_MAX_WAIT\s*\)/,
    'The queue must retain a hard max-wait that repeated mutations cannot postpone.');
  assert.doesNotMatch(queue, /clearTimeout\s*\(\s*applyMaxTimer\s*\)/,
    'DOM mutations must never reset the hard max-wait timer, or apply can starve.');
  assert.match(queue,
    /if\s*\(\s*prompt\s*===\s*true\s*&&\s*applyPromptTimer\s*===\s*null\s*\)[\s\S]*?setTimeout\s*\(\s*runQueuedApply\s*,\s*0\s*\)/,
    'Only an explicit prompt width update may bypass the delay; MutationObserver passes a truthy records array.');

  const widthResize = stock.match(/var\s+applyWidth\s*=\s*window\.innerWidth[\s\S]{0,500}?\},\s*\{\s*passive\s*:\s*true\s*\}\s*\);/);
  assert.ok(widthResize, 'Expected the width-only resize handler.');
  assert.match(widthResize[0],
    /if\s*\(\s*window\.innerWidth\s*===\s*applyWidth\s*\)\s*return\s*;[\s\S]*?queueApply\s*\(\s*true\s*\)/,
    'Real width changes must schedule a prompt apply after height-only keyboard resizes are ignored.');
});

test('smart-search results stay inside their host and wrap at mobile/tablet widths', () => {
  const panelRules = ruleBodies(stockCss, '.ngr-smart-search__panel');
  assert.ok(panelRules.some((body) => /left\s*:\s*0/i.test(body)
    && /right\s*:\s*auto/i.test(body)
    && /width\s*:\s*100%/i.test(body)
    && /max-width\s*:\s*100%/i.test(body)
    && /min-width\s*:\s*0/i.test(body)
    && /overflow-x\s*:\s*hidden/i.test(body)
    && /box-sizing\s*:\s*border-box/i.test(body)),
  'The panel must use its search host width at every breakpoint, including 768px, and suppress x-overflow.');

  const mobile = cssAtMost(stockCss, 600);
  const mobilePanelRules = ruleBodies(mobile, '.ngr-smart-search__panel');
  assert.ok(mobilePanelRules.some((body) => /left\s*:\s*0/i.test(body)
    && /right\s*:\s*auto/i.test(body)
    && /width\s*:\s*100%/i.test(body)
    && /max-width\s*:\s*100%/i.test(body)
    && /min-width\s*:\s*0/i.test(body)
    && /overflow-x\s*:\s*hidden/i.test(body)),
  'The <=600px override must not restore viewport-wide/right-anchored panel geometry.');

  const itemRules = ruleBodies(stockCss, '.ngr-smart-search__item');
  assert.ok(itemRules.some((body) => /width\s*:\s*100%/i.test(body)
    && /max-width\s*:\s*100%/i.test(body)
    && /min-width\s*:\s*0/i.test(body)
    && /box-sizing\s*:\s*border-box/i.test(body)
    && /white-space\s*:\s*normal/i.test(body)
    && /overflow-wrap\s*:\s*anywhere/i.test(body)),
  'Each result button must shrink and wrap instead of retaining Tilda white-space:nowrap.');

  for (const selector of [
    '.ngr-smart-search__item strong',
    '.ngr-smart-search__item span',
    '.ngr-smart-search__item small',
  ]) {
    const textRules = ruleBodies(stockCss, selector);
    assert.ok(textRules.some((body) => /width\s*:\s*100%/i.test(body)
      && /max-width\s*:\s*100%/i.test(body)
      && /min-width\s*:\s*0/i.test(body)
      && /box-sizing\s*:\s*border-box/i.test(body)
      && /white-space\s*:\s*normal/i.test(body)
      && /(?:overflow-wrap\s*:\s*anywhere|word-break\s*:\s*break-word)/i.test(body)),
    `${selector} must shrink and wrap inside the result button.`);
  }
});

test('mobile PVZ actions fit the 272px checkout column', () => {
  const mobile = cssAtMost(pvzCss, 600);
  const actions = ruleBodies(mobile, '.ngpvz__actions');
  const geo = ruleBodies(mobile, '.ngpvz__geo');
  const map = ruleBodies(mobile, '.ngpvz__maptoggle');
  const count = ruleBodies(mobile, '.ngpvz__count');

  const twoEqualColumns = /grid-template-columns\s*:\s*(?:repeat\(2\s*,\s*minmax\(0\s*,\s*1fr\)\)|minmax\(0\s*,\s*1fr\)\s+minmax\(0\s*,\s*1fr\))/i;
  assert.ok(actions.some((body) => /display\s*:\s*grid/i.test(body)
    && twoEqualColumns.test(body)),
  'At <=600px .ngpvz__actions needs two minmax(0,1fr) columns.');
  for (const [selector, rules] of [['.ngpvz__geo', geo], ['.ngpvz__maptoggle', map]]) {
    assert.ok(rules.some((body) => /width\s*:\s*100%/i.test(body)
      && /min-width\s*:\s*0/i.test(body)
      && /box-sizing\s*:\s*border-box/i.test(body)),
    `${selector} must shrink inside the two-column mobile grid.`);
  }
  assert.ok(count.some((body) => /grid-column\s*:\s*1\s*\/\s*-1/i.test(body)),
    '.ngpvz__count must occupy its own full-width grid row.');
});

test('PVZ map lifecycle rejects stale cities and clears stale UI state', () => {
  assert.match(pvz, /var\s+cityRequestSeq\s*=\s*0\s*;/,
    'PVZ city loads need a monotonically increasing request sequence.');
  assert.match(pvz, /var\s+requestSeq\s*=\s*\+\+cityRequestSeq\s*;/,
    'Every openByName() request must capture a new sequence value.');
  assert.match(pvz, /function\s+drawMap\s*\(requestSeq\)[\s\S]{0,300}requestSeq\s*!==\s*cityRequestSeq/,
    'A stale map-library response must not redraw an older city.');
  assert.match(pvz, /return\s+openCity\(city\s*,\s*keepMap\s*,\s*requestSeq\)/,
    'The city request sequence must reach the asynchronous shard load.');
  assert.match(pvz, /mapReady\s*===\s*['"]stale['"]/,
    'openByName() must surface stale completion without updating the UI.');
  assert.match(pvz, /cityInput\.addEventListener\(['"]input['"][\s\S]{0,180}cityRequestSeq\s*\+=\s*1/,
    'Typing a newer city must invalidate an in-flight request immediately.');

  assert.match(pvz, /function\s+clearMapCard\s*\(\)[\s\S]{0,250}\.ngpvz__mapcard[\s\S]{0,250}removeChild/,
    'The marker card needs a dedicated cleanup path.');
  assert.match(pvz, /function\s+destroyMap\s*\(\)[\s\S]{0,120}clearMapCard\s*\(\)/,
    'Destroying or replacing a map must remove its marker card.');
  assert.match(pvz, /function\s+pick\s*\(p\)[\s\S]{0,500}clearMapCard\s*\(\)[\s\S]{0,160}setMapButton\(['"]Показать карту['"]\s*,\s*false\s*,\s*false\)/,
    'Selecting a PVZ must close the map and synchronize its button state.');
  assert.match(pvz, /mapBtn\.addEventListener\(['"]click['"][\s\S]{0,300}clearMapCard\s*\(\)[\s\S]{0,160}setMapButton\(['"]Показать карту['"]\s*,\s*false\s*,\s*false\)/,
    'Closing the map must remove the marker card and reset text/ARIA state.');

  assert.match(pvz, /var\s+hasCurrentList\s*=/,
    'Load-error copy must first determine whether the visible list belongs to the current city.');
  assert.match(pvz, /hasCurrentList[\s\S]{0,220}Карта не загрузилась[\s\S]{0,220}Не удалось загрузить пункты/,
    'Map failure and city-data failure need different recovery copy.');
});
