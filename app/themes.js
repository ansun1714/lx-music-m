/* LX Music v1.9.2 主题系统
 * 移植自开源项目 src/theme/themes/{colorUtils,utils,themes/index}.js|.ts
 * 用同一套 primary 派生 232 个 c-primary-* 变量 + buildActiveThemeColors 别名，
 * 因此 16 套主题的每一处配色都与原版一致。
 */
(function () {
  'use strict';

  function parse(c) {
    var m = String(c).match(/-?[\d.]+/g);
    return m ? { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : null } : { r: 0, g: 0, b: 0, a: null };
  }
  function shade(p, c0) {
    var c = parse(c0), n = p < 0, t = n ? 0 : 255 * p, P = n ? 1 + p : 1 - p;
    var rgb = 'rgb' + (c.a == null ? '(' : 'a(') + Math.round(c.r * P + t) + ',' +
      Math.round(c.g * P + t) + ',' + Math.round(c.b * P + t);
    return rgb + (c.a == null ? ')' : ',' + c.a + ')');
  }
  function alphaShade(p, color) {
    var c = parse(color), n = p < 0, a;
    if (c.a != null) {
      a = c.a - (n ? (1 - c.a) * p : c.a * p);
      a = n ? Math.max(0, a) : Math.min(1, a);
    } else a = Math.min(1, 1 - p);
    return 'rgba(' + parseInt(c.r, 10) + ', ' + parseInt(c.g, 10) + ', ' +
      parseInt(c.b, 10) + ', ' + a.toFixed(2) + ')';
  }
  function pad3(n) { return ('000' + n).slice(-3); }

  function createThemeColors(primary, font, isDark) {
    var colors = { 'c-primary': primary }, pre, i, j;
    pre = primary;
    for (i = 1; i < 11; i++) {
      pre = shade(isDark ? 0.2 : -0.1, pre);
      colors['c-primary-dark-' + i * 100] = pre;
      for (j = 1; j < 10; j++) {
        colors['c-primary-dark-' + i * 100 + '-alpha-' + j * 100] = alphaShade(0.1 * j, pre);
        colors['c-primary-alpha-' + j * 100] = alphaShade(0.1 * j, primary);
      }
    }
    pre = primary;
    for (i = 1; i < 10; i++) {
      pre = shade(isDark ? -0.1 : 0.2, pre);
      colors['c-primary-light-' + i * 100] = pre;
      for (j = 1; j < 10; j++)
        colors['c-primary-light-' + i * 100 + '-alpha-' + j * 100] = alphaShade(0.1 * j, pre);
    }
    pre = shade(isDark ? -0.35 : 1, pre);
    colors['c-primary-light-1000'] = pre;
    for (j = 1; j < 10; j++)
      colors['c-primary-light-1000-alpha-' + j * 100] = alphaShade(0.1 * j, pre);
    colors['c-theme'] = isDark ? colors['c-primary-light-900'] : primary;

    var f = font || (isDark ? 'rgb(229, 229, 229)' : 'rgb(33, 33, 33)');
    colors['c-1000'] = f;
    if (isDark) {
      pre = f;
      for (i = 1; i < 21; i++) { pre = shade(-0.05, pre); colors['c-' + pad3(1000 - 50 * i)] = pre; }
    } else {
      for (i = 1; i < 21; i++) colors['c-' + pad3(1000 - 50 * i)] = shade(0.05 * i, f);
    }
    return colors;
  }

  // id / 名称 / primary / 是否深色 —— 全部取自 createThemes.js
  var THEMES = [
    { id: 'green', name: '绿意盎然', primary: 'rgb(77, 175, 124)' },
    { id: 'blue', name: '蓝田生玉', primary: 'rgb(52, 152, 219)' },
    { id: 'blue_plus', name: '蛋雅深蓝', primary: 'rgb(77, 131, 175)' },
    { id: 'orange', name: '橙黄橘绿', primary: 'rgb(245, 171, 53)' },
    { id: 'brown', name: '泥牛入海', primary: 'rgba(188, 128, 68, 1)' },
    { id: 'red', name: '热情似火', primary: 'rgb(214, 69, 65)' },
    { id: 'pink', name: '粉装玉琢', primary: 'rgb(241, 130, 141)' },
    { id: 'purple', name: '重斤球紫', primary: 'rgb(155, 89, 182)' },
    { id: 'grey', name: '灰常美丽', primary: 'rgb(108, 122, 137)' },
    { id: 'ming', name: '青出于黑', primary: 'rgb(51, 110, 123)' },
    { id: 'blue2', name: '清热板蓝', primary: 'rgb(79, 98, 208)' },
    { id: 'black', name: '黑灯瞎火', primary: 'rgb(190, 190, 190)', dark: true },
    { id: 'mid_autumn', name: '月里嫦娥', primary: 'rgb(74, 55, 82)' },
    { id: 'naruto', name: '木叶之村', primary: 'rgb(87, 144, 167)' },
    { id: 'china_ink', name: '近墨者黑', primary: 'rgba(47, 47, 47, 1)' },
    { id: 'happy_new_year', name: '新年快乐', primary: 'rgb(192, 57, 43)' }
  ];

  var ALIASES = {
    'c-font': 'c-850', 'c-font-label': 'c-450', 'c-primary-font': 'c-primary',
    'c-primary-font-hover': 'c-primary-alpha-300',
    'c-primary-font-active': 'c-primary-dark-100-alpha-200',
    'c-primary-background': 'c-primary-light-400-alpha-700',
    'c-primary-input-background': 'c-primary-light-400-alpha-700',
    'c-button-font': 'c-primary-alpha-100',
    'c-button-font-selected': 'c-primary-dark-100-alpha-100',
    'c-button-background': 'c-primary-light-400-alpha-700',
    'c-button-background-selected': 'c-primary-alpha-600',
    'c-button-background-hover': 'c-primary-light-300-alpha-600',
    'c-button-background-active': 'c-primary-light-100-alpha-600',
    'c-list-header-border-bottom': 'c-primary-alpha-900',
    'c-content-background': 'c-primary-light-1000',
    'c-border-background': 'c-primary-light-100-alpha-700'
  };

  function build(t) {
    var dark = !!t.dark;
    var cols = createThemeColors(t.primary, dark ? 'rgb(255, 255, 255)' : 'rgb(33, 33, 33)', dark);
    var out = {};
    Object.keys(cols).forEach(function (k) { out[k] = cols[k]; });
    Object.keys(ALIASES).forEach(function (k) { out[k] = cols[ALIASES[k]] || ''; });
    out['c-main-background'] = dark ? 'rgba(19, 19, 19, 0.95)' : 'rgba(255, 255, 255, 1)';
    out['c-app-background'] = dark ? 'rgba(0, 0, 0, 0)' : 'var(--c-primary-light-600-alpha-700)';
    out['c-badge-primary'] = dark ? cols['c-primary-dark-200'] : cols['c-primary'];
    out['c-badge-secondary'] = dark ? cols['c-primary'] : '#4baed5';
    out['c-badge-tertiary'] = dark ? cols['c-primary-dark-300'] : '#e7aa36';
    return out;
  }

  function apply(id) {
    var t = THEMES.filter(function (x) { return x.id === id; })[0] || THEMES[0];
    var cols = build(t), root = document.documentElement;
    Object.keys(cols).forEach(function (k) {
      var v = String(cols[k] || '').replace(/var\((c-[^)]+)\)/g, 'var(--$1)');
      root.style.setProperty('--' + k, v);
    });
    root.setAttribute('data-theme', t.id);
    root.setAttribute('data-dark', t.dark ? '1' : '0');
    return t;
  }

  window.LXTheme = { list: THEMES, apply: apply, build: build, colors: createThemeColors };
})();
