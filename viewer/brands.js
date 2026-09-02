/* Brand logos inside map pins (inline SVG data URIs — no external assets). */
(function () {
  const shell = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#FFD500" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="11" font-weight="700" fill="#E31837">S</text></svg>'
  );
  const bp = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#007749" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="10" font-weight="700" fill="#FFD700">BP</text></svg>'
  );
  const caltex = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#E31837" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="9" font-weight="700" fill="#fff">CAL</text></svg>'
  );
  const ampol = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#E31837" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">AMP</text></svg>'
  );
  const seven = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#007A33" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="10" font-weight="700" fill="#fff">7</text></svg>'
  );
  const united = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#1e3a8a" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">U</text></svg>'
  );
  const liberty = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#7c3aed" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">L</text></svg>'
  );
  const metro = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#dc2626" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="8" font-weight="700" fill="#fff">M</text></svg>'
  );
  const mobil = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#E31837" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="9" font-weight="700" fill="#fff">Mob</text></svg>'
  );
  const generic = encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#475569" cx="16" cy="16" r="15"/><text x="16" y="21" text-anchor="middle" font-family="Arial" font-size="10" font-weight="700" fill="#fff">⛽</text></svg>'
  );

  const RULES = [
    ['shell', shell],
    ['bp', bp],
    ['caltex', caltex],
    ['ampol', ampol],
    ['eg ', ampol],
    ['7-eleven', seven],
    ['seven', seven],
    ['united', united],
    ['liberty', liberty],
    ['metro', metro],
    ['mobil', mobil],
    ['costco', generic],
    ['puma', generic],
    ['night', generic],
  ];

  window.brandLogoFor = function (brand) {
    const b = (brand || '').toLowerCase();
    for (const [needle, svg] of RULES) {
      if (b.includes(needle)) return `data:image/svg+xml,${svg}`;
    }
    return `data:image/svg+xml,${generic}`;
  };
})();
