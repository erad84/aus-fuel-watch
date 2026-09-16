/* Brand logos for map pins / summary — local files under viewer/brands/.
 *
 * Covers major AU network brands from published catalogs. Independents and
 * one-off servos fall back to a neutral glyph.
 */
(function () {
  const generic = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#475569" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="10" font-weight="700" fill="#fff">⛽</text></svg>'
  );

  function local(file) {
    try {
      const scripts = document.getElementsByTagName('script');
      for (let i = scripts.length - 1; i >= 0; i--) {
        const src = scripts[i].src || '';
        if (src.includes('brands.js')) {
          return src.replace(/brands\.js(?:\?.*)?$/, 'brands/' + file);
        }
      }
    } catch (_) {
      /* ignore */
    }
    return 'brands/' + file;
  }

  // Longest / most specific needles first.
  const RULES = [
    // Ampol family
    ['ampol mood food', local('ampol.png')],
    ['ampol foodary', local('ampol.png')],
    ['ampol breeze', local('ampol.png')],
    ['ampol bennetts', local('ampol.png')],
    ['eg ampol', local('ampol.png')],
    ['ebm ampol', local('ampol.png')],
    ['ampol', local('ampol.png')],
    ['eg ', local('ampol.png')],
    ['bennetts petroleum', local('ampol.png')],

    // 7-Eleven
    ['7-eleven', local('7eleven.svg')],
    ['7 eleven', local('7eleven.svg')],
    ['seven eleven', local('7eleven.svg')],
    ['seven', local('7eleven.svg')],

    // Majors
    ['shell otr', local('shell.png')],
    ['shell', local('shell.png')],
    ['bp', local('bp.svg')],
    ['caltex', local('caltex.png')],
    ['mobil', local('mobil.svg')],
    ['united', local('united.png')],
    ['liberty', local('liberty.png')],
    ['costco', local('costco.svg')],
    ['puma energy', local('puma.png')],
    ['puma', local('puma.png')],

    // Metro / Reddy / OTR
    ['metro petroleum', local('metro.png')],
    ['metro fuel', local('metro.png')],
    ['omg metro', local('metro.png')],
    ['metro', local('metro.png')],
    ['reddy', local('reddy.png')],
    ['on the run', local('otr.png')],
    ['otr', local('otr.png')],

    // Regional / independents with assets
    ['pearl', local('pearl.png')],
    ['ior pty', local('ior.png')],
    ['ior group', local('ior.png')],
    ['ior', local('ior.png')],
    ['speedway', local('speedway.png')],
    ['woodham', local('woodham.png')],
    ['freedom', local('freedom.png')],
    ['budget', local('budget.png')],
    ['lowes', local('lowes.png')],
    ['u-go', local('ugo.png')],
    ['ugo', local('ugo.png')],
    ['x convenience', local('xconvenience.png')],
    ['xconvenience', local('xconvenience.png')],
    ['enhance', local('enhance.png')],
    ['atlas fuel', local('atlas.png')],
    ['atlas', local('atlas.png')],
    ['inland', local('inland.png')],
    ['tas petroleum', local('taspetroleum.png')],
    ['ultra petroleum', local('ultra.png')],
    ['ultra', local('ultra.png')],
    ['pacific fuel', local('pacific.png')],
    ['pacific petroleum', local('pacific.png')],
    ['pacific', local('pacific.png')],
    ['solo', local('solo.png')],
    ['better choice', local('betterchoice.png')],
    ['gull', local('gull.png')],
    ['perry', local('perry.png')],
    ['am/pm', local('ampm.png')],
    ['am pm', local('ampm.png')],
    ['hopefuel', local('hopefuel.png')],
    ['hope fuel', local('hopefuel.png')],
    ['wa fuels', local('wafuels.png')],
    ['eagle', local('eagle.png')],
    ['petro fuels', local('petro.png')],
    ['petro', local('petro.png')],
    ['transwest', local('transwest.png')],
    ['arko', local('arko.png')],
    ['vultra', local('vultra.png')],
    ['maisey', local('maisey.png')],
    ['apco', local('apco.png')],
  ];

  window.brandLogoFor = function (brand) {
    const b = (brand || '').toLowerCase().trim();
    if (!b || b === 'independent' || b === 'unknown') {
      return `data:image/svg+xml,${generic}`;
    }
    for (const [needle, url] of RULES) {
      if (b.includes(needle)) return url;
    }
    return `data:image/svg+xml,${generic}`;
  };
})();
