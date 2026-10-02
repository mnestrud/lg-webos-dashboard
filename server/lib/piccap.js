/* PicCap's Luna and MQTT controls. Strict ES5. */
var msg = require('./say').msg;
var SERVICE = 'org.webosbrew.piccap.service/';
var STATUS_CACHE_MS = 4000;
var lunaFn = null;
var available = false;
var isRunning = null;
var checkedAt = 0;
var inFlight = false;
var waiters = [];
var forceWaiters = [];
var mqttClient = null;
var stateTopic = '';
var allowControl = false;
// null forces the next publish, as after a (re)connect.
var lastPayload = null;

function current() {
  return { available: available, isRunning: isRunning };
}

function missingService(response, raw) {
  var text = String(response && (response.errorText || response.error) || raw || '').toLowerCase();
  return /unknown method|no such service|service.{0,24}(not found|does not exist|not registered)|method.{0,24}(not found|does not exist)/.test(text);
}

function flush(callbacks, value) {
  for (var i = 0; i < callbacks.length; i++) {
    try { callbacks[i](value); } catch (e) {}
  }
}

function requestStatus() {
  checkedAt = Date.now();
  lunaFn(SERVICE + 'status', {}, function (response, raw) {
    if (response && response.returnValue !== false && typeof response.isRunning === 'boolean') {
      available = true;
      isRunning = response.isRunning;
    } else if (missingService(response, raw)) {
      available = false;
      isRunning = null;
    }

    var callbacks = waiters;
    waiters = [];
    var refresh = forceWaiters.length > 0;
    if (refresh) {
      waiters = forceWaiters;
      forceWaiters = [];
    } else {
      inFlight = false;
    }
    flush(callbacks, current());
    if (refresh) requestStatus();
  });
}

function getStatus(cb, force) {
  cb = cb || function () {};
  var now = Date.now();
  if (inFlight) {
    (force ? forceWaiters : waiters).push(cb);
    return;
  }
  if (!force && checkedAt && now >= checkedAt && now - checkedAt < STATUS_CACHE_MS) return cb(current());

  inFlight = true;
  waiters.push(cb);
  requestStatus();
}

function setPower(on, cb) {
  if (typeof on !== 'boolean') return cb({ ok: false, error: 'power must be true or false' });
  getStatus(function (state) {
    if (!state.available) {
      return cb({ ok: false, available: false, error: msg('srv.piccap.unavailable', 'PicCap is not available') });
    }
    lunaFn(SERVICE + (on ? 'start' : 'stop'), {}, function (response) {
      var ok = !!(response && response.returnValue === true);
      var error = response && (response.errorText || response.errorCode);
      setTimeout(function () {
        getStatus(function (latest) {
          cb({
            ok: ok,
            available: latest.available,
            isRunning: latest.isRunning,
            error: ok ? undefined : (error || msg('srv.piccap.refused', 'PicCap refused the request'))
          });
        }, true);
      }, 400);
    });
  });
}

function publishState() {
  if (!mqttClient || !mqttClient.connected) return;
  var state = current();
  var payload = state.available && typeof state.isRunning === 'boolean' ? (state.isRunning ? 'ON' : 'OFF') : '';
  if (payload === lastPayload) return;
  lastPayload = payload;
  mqttClient.publish(stateTopic, payload, true);
}

function poll(cb) {
  getStatus(function (state) {
    publishState();
    if (cb) cb(state);
  }, true);
}

// The broker may have lost the retained state, so the next poll republishes it.
function onConnect(cb) {
  lastPayload = null;
  poll(cb);
}

function addToTelemetry(stats) {
  var state = current();
  if (state.available && typeof state.isRunning === 'boolean') stats.piccap = { isRunning: state.isRunning };
  else delete stats.piccap;
}

function attachMqtt(opts) {
  opts = opts || {};
  mqttClient = opts.client || null;
  stateTopic = (opts.prefix || 'lgtv') + '/state/piccap/power';
  allowControl = opts.allowControl === true;
}

function handleMqttCommand(action, value, cb) {
  if (action !== 'piccap/power') return false;
  var power = String(value === undefined || value === null ? '' : value).toUpperCase();
  if (power !== 'ON' && power !== 'OFF') {
    var invalid = { ok: false, error: 'power must be ON or OFF' };
    console.log('mqtt: PicCap command failed: ' + JSON.stringify(invalid));
    if (cb) cb(invalid);
    return true;
  }
  if (!allowControl) {
    var disabled = { ok: false, error: msg('srv.controlsOff', 'controls disabled in config') };
    console.log('mqtt: PicCap command failed: ' + JSON.stringify(disabled));
    if (cb) cb(disabled);
    return true;
  }
  setPower(power === 'ON', function (result) {
    publishState();
    if (!result || !result.ok) console.log('mqtt: PicCap command failed: ' + JSON.stringify(result));
    if (cb) cb(result);
  });
  return true;
}

function init(opts) {
  opts = opts || {};
  lunaFn = opts.luna;
  return {
    attachMqtt: attachMqtt,
    poll: poll,
    onConnect: onConnect,
    addToTelemetry: addToTelemetry,
    handleMqttCommand: handleMqttCommand
  };
}

module.exports = { init: init };
