/**
 * test/test-screensaver-switch.js - Custom screen savers held back where the
 * stock one is Flutter (webOS 10 and 11, #366), and the pause while sam
 * restarts to go back to it
 */

var assert = require('assert');
var path = require('path');
var child = require('child_process');
var mockEnv = require('./mocks/mock-env');

var APP = '/usr/palm/applications/com.webos.app.screensaver';
var STOCK_TYPE_FILE = '/var/lib/tvweb/screensaver-stock-type';

var restarts = [];
var onUmount = function () {};
// The module keeps its own reference to execFile, so this has to be in place
// before it is required.
child.execFile = function (file, args, opts, cb) {
  if (file === '/bin/systemctl') restarts.push(args.join(' '));
  if (file === '/bin/umount') onUmount();
  process.nextTick(function () { cb(null, '', ''); });
};

// Timers run at once, so the poll and the settle delay need no waiting.
global.setTimeout = function (fn) { process.nextTick(fn); return 0; };

var polls = 0;
var ssRequests = 0;
var env = mockEnv.createMockEnv({
  files: {},
  luna: {
    // sam holds our runner until the restart, then does not answer for a
    // while, then answers with LG's.
    'com.webos.applicationManager/getAppInfo': function () {
      if (restarts.length === 0) return { returnValue: true, appInfo: { type: 'qml' } };
      polls++;
      if (polls < 3) return null;
      return { returnValue: true, appInfo: { type: 'flutter' } };
    },
    'com.webos.service.tvpower/power/getPowerState': { returnValue: true, state: 'Active' },
    'com.webos.applicationManager/getForegroundAppInfo': { returnValue: true, appId: 'com.webos.app.home' },
    'com.webos.service.tvpower/power/turnOnScreenSaver': function () {
      ssRequests++;
      return { returnValue: true };
    },
    'com.webos.applicationManager/closeByAppId': { returnValue: true }
  }
});
// A TV updated from a version that mounted Starfield over a Flutter stock.
env.files[STOCK_TYPE_FILE] = 'flutter';
env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"qml","main":"qml/main.qml"}';
env.files[path.join(APP, '.tvweb-screensaver')] = 'starfield';
env.files['/tmp/tvweb-test/clock.qml'] = 'Item {}';
env.install();

// Unmounting shows LG's app at the path again.
onUmount = function () {
  env.files[path.join(APP, 'appinfo.json')] = '{"id":"com.webos.app.screensaver","type":"flutter","main":"main"}';
  env.files[path.join(APP, '.tvweb-screensaver')] = null;
};

var screensavers = require('../server/lib/screensavers');

console.log('Running test-screensaver-switch.js ...');

screensavers.init({
  luna: env.mockLuna,
  assetPath: function (qml) { return qml === 'screensavers/clock.qml' ? '/tmp/tvweb-test/clock.qml' : null; },
  config: { port: 8080, allowControl: true },
  mapPowerState: function (s) { return { raw: s }; },
  isScreenSaver: function () { return false; }
});

var realNextTick = process.nextTick;

realNextTick(function waitRevert() {
  if (!screensavers.switching()) return realNextTick(waitRevert);

  // 1. Starting with one of ours mounted goes back to LG's and restarts sam
  assert.strictEqual(restarts.length, 1);
  assert.ok(/restart --no-block sam/.test(restarts[0]));
  assert.strictEqual(screensavers.screensaverMode(), 'stock');
  console.log('  ✓ a custom screen saver left mounted goes back to the LG default');

  // 2. Nothing may start or change a screen saver until sam is back
  screensavers.trigger(function (t) {
    assert.strictEqual(t.ok, false);
    assert.ok(/still switching/.test(t.error));
    assert.strictEqual(ssRequests, 0);
    console.log('  ✓ start requests are refused while sam restarts');

    realNextTick(function waitClear() {
      if (screensavers.switching()) return realNextTick(waitClear);
      assert.ok(polls >= 3, 'cleared before sam came back');

      // 3. Custom ones are listed as unavailable and refused
      var list = screensavers.screensaverList();
      assert.strictEqual(list.held, true);
      list.modes.forEach(function (m) {
        assert.strictEqual(m.available, m.id === 'stock', m.id);
      });
      screensavers.setScreensaver('clock', 'dim', function (r) {
        assert.strictEqual(r.ok, false);
        assert.ok(/turned off on this TV/.test(r.error));
        assert.strictEqual(restarts.length, 1);
        console.log('  ✓ custom screen savers are unavailable and refused where the stock one is Flutter');

        // 4. LG's own still starts once sam is back
        screensavers.trigger(function (t) {
          assert.strictEqual(t.ok, true);
          assert.strictEqual(ssRequests, 1);
          console.log('  ✓ the LG default starts once sam is back');
          console.log('ALL test-screensaver-switch.js assertions passed!\n');
          env.restore();
        });
      });
    });
  });
});
