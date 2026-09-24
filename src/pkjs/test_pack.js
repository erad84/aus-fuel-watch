/**
 * Node tests for pkjs helpers (no Pebble runtime).
 * Run: node src/pkjs/test_pack.js
 */
var assert = require('assert');

// Minimal stubs
global.Pebble = {
  addEventListener: function () {},
  sendAppMessage: function (d, ok) {
    ok && ok();
  },
  openURL: function () {},
};
global.localStorage = {
  _d: {},
  getItem: function (k) {
    return this._d[k] || null;
  },
  setItem: function (k, v) {
    this._d[k] = String(v);
  },
  removeItem: function (k) {
    delete this._d[k];
  },
};
global.fetch = function () {
  return Promise.reject(new Error('no network in tests'));
};
global.navigator = {};

var mod = require('./index.js');

assert.strictEqual(mod.primaryFuel({ preferredFuel: 'U91+E10' }), 'U91');
assert.strictEqual(mod.primaryFuel({ preferredFuel: 'DSL' }), 'DSL');

assert.strictEqual(
  mod.homeContext({ favourites: [{ id: '1' }], areaLat: -33, areaLng: 151 }),
  'favourites'
);
assert.strictEqual(mod.homeContext({ favourites: [], areaLat: -33, areaLng: 151 }), 'suburb');
assert.strictEqual(mod.homeContext({ favourites: [] }), 'scope');

var dial = mod.inferDial([150, 148, 146, 144, 142]);
assert.ok(dial.label);
assert.ok(dial.label.indexOf('Fav') === -1);
assert.ok(dial.angle >= 0 && dial.angle < 360);

var ds = mod.downsample([100, 110, 120, 130], 4);
assert.strictEqual(ds.pts.length, 4);
assert.strictEqual(ds.pts[0], 0);
assert.strictEqual(ds.pts[3], 255);

assert.strictEqual(
  mod.titleFor({
    preferredFuel: 'U91+E10',
    favourites: [{ id: '1' }],
    homeState: 'NSW',
    defaultScope: 'metro',
  }),
  'U91 Cycle Stage'
);
assert.strictEqual(
  mod.titleFor({
    preferredFuel: 'U91',
    favourites: [],
    areaLat: -33.8,
    areaLng: 151.2,
    areaSuburb: 'Mosman',
  }),
  'U91 Cycle Stage'
);
assert.strictEqual(
  mod.titleFor({
    preferredFuel: 'P95',
    favourites: [],
    homeState: 'NSW',
    defaultScope: 'metro',
  }),
  'P95 Cycle Stage'
);
assert.strictEqual(
  mod.scopeTitle({ homeState: 'NSW', defaultScope: 'state' }),
  'NSW'
);
assert.strictEqual(mod.dayPriceMap({ s: [['id1', { U91: 2075 }]] }).id1.U91, 2075);
assert.strictEqual(
  mod.latestDayIso({ snapshot: { asOf: '2026-09-16T10:00:00Z' }, start: '2026-06-19' }),
  '2026-09-16'
);

console.log('pkjs tests ok');
