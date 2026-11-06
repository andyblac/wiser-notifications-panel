const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const plain = value => JSON.parse(JSON.stringify(value));

function setup() {
  const elements = {};
  const context = {
    console,
    Intl,
    window:{},
    document:{documentElement:{lang:"en-US"}},
    requestAnimationFrame(callback) { callback(); return 1; },
    cancelAnimationFrame() {},
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    HTMLElement: class {
      constructor() { this.isConnected = true; }
      attachShadow() {
        this.shadowRoot = {innerHTML:"", addEventListener() {}};
      }
      dispatchEvent(event) { this.lastEvent = event; return true; }
      toggleAttribute() {}
    },
    customElements:{
      get(name) { return elements[name]; },
      define(name, constructor) { elements[name] = constructor; },
    },
  };
  const languages = [
    "da", "de", "en-US", "en-GB", "es", "fi", "fr", "hu", "nb", "nl", "pt", "sv",
  ];
  const translations = Object.fromEntries(languages.map(language => [
    language,
    JSON.parse(fs.readFileSync(path.join(__dirname, `../src/localize/languages/${language}.json`), "utf8")),
  ]));
  const source = fs.readFileSync(path.join(__dirname, "../src/wiser-notifications-panel.js"), "utf8")
    .replaceAll("__WISER_NOTIFICATIONS_TRANSLATIONS__", JSON.stringify(translations));
  vm.runInNewContext(source, context);
  return {Panel:elements["wiser-notifications-panel"], helpers:context.window.WiserNotificationsPanelTest, translations};
}

test("registers the Wiser Notifications panel", () => {
  const {Panel} = setup();
  assert.equal(typeof Panel, "function");
  assert.equal(Panel.panelApiVersion, 1);
  assert.equal(typeof Panel.prototype._openEditor, "function");
});

test("uses an automation heading only for the automations category", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._hass = {locale:{language:"en-GB"}, user:{is_admin:true}};

  panel._category = "automations";
  panel._render();
  assert.match(panel.shadowRoot.innerHTML, /<h2>Automations<\/h2><p>Automations stored on your Wiser hub<\/p>/);

  panel._category = "equipment";
  panel._render();
  assert.match(panel.shadowRoot.innerHTML, /<h2>Notifications<\/h2><p>Native alerts stored on your Wiser hub<\/p>/);
});

test("routine Home Assistant updates do not rebuild an active form", () => {
  const {Panel} = setup();
  const panel = new Panel();
  const connection = {};
  let loads = 0;
  let renders = 0;
  panel._load = () => { loads += 1; };
  panel._renderSoon = () => { renders += 1; };

  panel.hass = {connection, locale:{language:"en-GB"}, user:{is_admin:true}};
  panel.hass = {
    connection,
    locale:{language:"en-GB"},
    user:{is_admin:true},
    states:{changed:true},
  };

  assert.equal(loads, 1);
  assert.equal(renders, 0);

  panel.hass = {connection, locale:{language:"fr"}, user:{is_admin:true}};
  assert.equal(renders, 1);
});

test("reloads the selected hub when the integration reports an update", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._hub = "Home";
  const loads = [];
  let callback;
  let unsubscribed = false;
  const connection = {
    async subscribeMessage(handler, message) {
      callback = handler;
      assert.deepEqual(plain(message), {type:"wiser_updated"});
      return () => { unsubscribed = true; };
    },
  };
  panel._hass = {connection};
  panel._load = silent => { loads.push(silent); };

  await panel._subscribeUpdates();
  callback({hub:"Other"});
  assert.deepEqual(loads, []);
  callback({hub:"Home"});
  assert.deepEqual(loads, [true]);

  panel.disconnectedCallback();
  assert.equal(unsubscribed, true);
});

test("notification defaults preserve configured zero values", () => {
  const {helpers} = setup();
  assert.deepEqual(
    {...helpers.notificationDraft({period_mins:0, limit:0, enabled:false}, "under")},
    {configured:true, period_mins:0, limit:0, enabled:false},
  );
  assert.deepEqual(
    {...helpers.notificationDraft(null, "over")},
    {configured:false, period_mins:5, limit:100, enabled:true},
  );
});

test("shows monitored equipment and equipment with configured notifications", () => {
  const {helpers} = setup();
  const equipment = [
    {equipment_id:1, monitored:true, notifications:{}},
    {equipment_id:2, monitored:false, notifications:{over:{enabled:true}}},
    {equipment_id:3, monitored:false, notifications:{}},
  ];
  assert.deepEqual(Array.from(helpers.compatibleEquipment(equipment), item => item.equipment_id), [1, 2]);
});

test("always shows Automations and limits other tabs to categories reported by the hub", () => {
  const {helpers} = setup();
  const notifications = {
    equipment:[{equipment_id:1, monitored:true, notifications:{}}],
    smoke_alarms:[],
    sensors:[{device_id:2, enabled:true}],
    automations:[],
  };

  assert.deepEqual(
    Array.from(helpers.availableCategories(notifications)),
    ["equipment", "sensors", "automations"],
  );
});

test("orders category tabs alphabetically using their translated labels", () => {
  const {helpers} = setup();
  const notifications = {
    equipment:[{equipment_id:1, monitored:true, notifications:{}}],
    smoke_alarms:[{}], sensors:[{}], automations:[{}],
  };

  assert.deepEqual(
    Array.from(helpers.localizedCategories(notifications, {language:"en-US"})),
    ["automations", "equipment", "sensors", "smoke_alarms"],
  );
  assert.deepEqual(
    Array.from(helpers.localizedCategories(notifications, {language:"fr"})),
    ["automations", "sensors", "smoke_alarms", "equipment"],
  );
});

test("orders devices from saved panel settings and appends new devices", () => {
  const {helpers} = setup();
  const items = [
    {equipment_id:1, name:"One"},
    {equipment_id:2, name:"Two"},
    {equipment_id:3, name:"Three"},
  ];
  assert.deepEqual(
    Array.from(helpers.orderedItems("equipment", items, ["3", "1"]), item => item.equipment_id),
    [3, 1, 2],
  );
  assert.equal(helpers.deviceColumns(3), 3);
  assert.equal(helpers.deviceColumns(4), 4);
  assert.equal(helpers.deviceColumns(5), 2);
  assert.equal(helpers.deviceColumns(undefined, 1), 1);
  assert.equal(helpers.deviceColumns("invalid"), 2);
});

test("localizes supported languages and falls back to English", () => {
  const {helpers} = setup();
  assert.equal(helpers.languageFor({locale:{language:"en-GB"}}), "en-GB");
  assert.equal(helpers.languageFor({language:"fr-FR"}), "fr");
  assert.equal(helpers.languageFor({language:"nb-NO"}), "nb");
  assert.equal(helpers.languageFor({language:"no-NO"}), "nb");
  assert.equal(helpers.languageFor({language:"pt-BR"}), "pt");
  assert.equal(helpers.localize("panel.title", {language:"de"}), "Benachrichtigungen");
  assert.equal(helpers.localize("panel.title", {language:"es"}), "Notificaciones");
  assert.equal(helpers.localize("panel.title", {language:"it"}), "Notifications");
});

test("keeps translation keys and placeholders aligned", () => {
  const {translations} = setup();
  const english = translations["en-US"];
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [language, translated] of Object.entries(translations)) {
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort(), language);
    for (const key of Object.keys(english)) {
      assert.deepEqual(placeholders(translated[key]), placeholders(english[key]), `${language}: ${key}`);
    }
  }
});

test("loads native notifications from the selected hub", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._hubs = ["Home"];
  panel._hass = {
    callWS:async message => {
      assert.deepEqual(plain(message), {type:"wiser/notifications", hub:"Home"});
      return {
        equipment:[{equipment_id:1, monitored:true, notifications:{under:null, over:null}}],
        smoke_alarms:[],
        sensors:[],
        automations:[],
      };
    },
  };
  await panel._load();
  assert.equal(panel._notifications.equipment.length, 1);
  assert.equal(panel._drafts.get("1:under").limit, 0);
  assert.equal(panel._drafts.get("1:over").limit, 100);
});

test("silent updates preserve unsaved automation status changes", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._hubs = ["Home"];
  panel._deviceDrafts.set("automations:12", {
    enabled:false,
    notification_enabled:true,
  });
  panel._originalDeviceDrafts.set("automations:12", {
    enabled:true,
    notification_enabled:false,
  });
  panel._hass = {
    callWS:async () => ({
      equipment:[], smoke_alarms:[], sensors:[],
      automations:[{
        automation_id:12,
        enabled:true,
        notification_enabled:false,
      }],
    }),
  };

  await panel._load(true);

  assert.deepEqual(plain(panel._deviceDrafts.get("automations:12")), {
    enabled:false,
    notification_enabled:true,
  });
  assert.deepEqual(plain(panel._originalDeviceDrafts.get("automations:12")), {
    enabled:true,
    notification_enabled:false,
  });
});

test("saves all three native notification settings together", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._drafts.set("1:over", {configured:false, period_mins:10, limit:250, enabled:false});
  let request;
  panel._hass = {
    user:{is_admin:true},
    callWS:async message => {
      request = message;
      return [{equipment_id:1, monitored:true, notifications:{over:{period_mins:10, limit:250, enabled:false}}}];
    },
  };
  const section = {
    dataset:{equipmentId:"1", notification:"over"},
    querySelectorAll:() => [{reportValidity:() => true}],
  };
  await panel._save(section);
  assert.deepEqual(plain(request), {
    type:"wiser/power_notification/set",
    hub:"Home",
    equipment_id:1,
    notification_type:"over",
    period_mins:10,
    limit:250,
    enabled:false,
  });
});

test("saves a supported device notification toggle", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._deviceDrafts.set("sensors:8", {enabled:false});
  panel._originalDeviceDrafts.set("sensors:8", {enabled:true});
  let request;
  panel._hass = {
    user:{is_admin:true},
    callWS:async message => {
      request = message;
      return {
        equipment:[],
        smoke_alarms:[],
        sensors:[{device_id:8, enabled:false}],
        automations:[],
      };
    },
  };

  await panel._saveDevice({
    dataset:{category:"sensors", deviceId:"8"},
  }, "enabled");

  assert.deepEqual(plain(request), {
    type:"wiser/device_notification/set",
    hub:"Home",
    category:"sensor",
    device_id:8,
    enabled:false,
  });
  assert.equal(panel._deviceDrafts.get("sensors:8").enabled, false);
});

test("saves a writable automation enabled toggle", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._deviceDrafts.set("automations:12", {enabled:false});
  panel._originalDeviceDrafts.set("automations:12", {enabled:true});
  let request;
  panel._hass = {
    user:{is_admin:true},
    callWS:async message => {
      request = message;
      return {
        equipment:[], smoke_alarms:[], sensors:[],
        automations:[{
          automation_id:12,
          name:"Door left open",
          enabled:false,
          writable:true,
        }],
      };
    },
  };

  await panel._saveDevice({
    dataset:{category:"automations", deviceId:"12"},
  }, "enabled");

  assert.deepEqual(plain(request), {
    type:"wiser/automation/set_enabled",
    hub:"Home",
    automation_id:12,
    enabled:false,
  });
  assert.equal(panel._deviceDrafts.get("automations:12").enabled, false);
});

test("saves a writable automation notification toggle", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._deviceDrafts.set("automations:12", {
    enabled:true,
    notification_enabled:false,
  });
  panel._originalDeviceDrafts.set("automations:12", {
    enabled:true,
    notification_enabled:true,
  });
  let request;
  panel._hass = {
    user:{is_admin:true},
    callWS:async message => {
      request = message;
      return {
        equipment:[], smoke_alarms:[], sensors:[],
        automations:[{
          automation_id:12,
          name:"Door left open",
          enabled:true,
          notification_enabled:false,
          writable:true,
          notification_writable:true,
        }],
      };
    },
  };

  await panel._saveDevice({
    dataset:{category:"automations", deviceId:"12"},
  }, "notification_enabled");

  assert.deepEqual(plain(request), {
    type:"wiser/automation/set_notification_enabled",
    hub:"Home",
    automation_id:12,
    enabled:false,
  });
  assert.equal(
    panel._deviceDrafts.get("automations:12").notification_enabled,
    false,
  );
});

test("saving one automation option preserves the other unsaved option", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._deviceDrafts.set("automations:12", {
    enabled:false,
    notification_enabled:false,
  });
  panel._originalDeviceDrafts.set("automations:12", {
    enabled:true,
    notification_enabled:true,
  });
  panel._hass = {
    user:{is_admin:true},
    callWS:async () => ({
      equipment:[], smoke_alarms:[], sensors:[],
      automations:[{
        automation_id:12,
        enabled:false,
        notification_enabled:true,
      }],
    }),
  };

  await panel._saveDevice({
    dataset:{category:"automations", deviceId:"12"},
  }, "enabled");

  assert.equal(panel._deviceDrafts.get("automations:12").enabled, false);
  assert.equal(
    panel._deviceDrafts.get("automations:12").notification_enabled,
    false,
  );
  assert.equal(panel._isDeviceFieldDirty("automations:12", "enabled"), false);
  assert.equal(
    panel._isDeviceFieldDirty("automations:12", "notification_enabled"),
    true,
  );
});

test("deletes a Wiser automation", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  let request;
  panel._hass = {
    user:{is_admin:true},
    callWS:async message => {
      request = message;
      return {equipment:[], smoke_alarms:[], sensors:[], automations:[]};
    },
  };

  await panel._deleteAutomation(12);

  assert.deepEqual(plain(request), {
    type:"wiser/automation/delete",
    hub:"Home",
    automation_id:12,
  });
  assert.equal(panel._notifications.automations.length, 0);
});

test("opens a native Home Assistant automation delete dialog", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._hass = {user:{is_admin:true}};
  const dialog = {open:false};
  panel.shadowRoot.querySelector = selector => selector === "#automation-delete-dialog" ? dialog : null;

  panel._openAutomationDelete({dataset:{deviceId:"12"}});

  assert.equal(panel._automationDeleteId, 12);
  assert.equal(dialog.open, true);
});

test("renders native Home Assistant automation delete actions", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._render();

  assert.match(panel.shadowRoot.innerHTML, /<ha-dialog id="automation-delete-dialog" width="medium">/);
  assert.match(panel.shadowRoot.innerHTML, /class="delete-confirmation">Delete this Wiser automation\?/);
  assert.match(panel.shadowRoot.innerHTML, /slot="footer"/);
  assert.match(panel.shadowRoot.innerHTML, /variant="danger" data-action="delete-automation-confirm">Delete/);
});

test("keeps the automation delete dialog open across panel refreshes", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._automationDeleteId = 12;
  const dialog = {
    open:false,
    setAttribute() {},
    addEventListener() {},
    querySelector() { return null; },
  };
  panel.shadowRoot.querySelector = selector => selector === "#automation-delete-dialog" ? dialog : null;

  panel._render();

  assert.equal(dialog.open, true);
  assert.equal(panel._automationDeleteId, 12);
});

test("renders writable automations with actionable status controls", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._notifications = {
    equipment:[], smoke_alarms:[], sensors:[],
    automations:[{
      automation_id:12,
      name:"Door left open",
      enabled:true,
      notification_enabled:false,
      writable:true,
      notification_writable:true,
      deletable:true,
      details:{
        trigger_mode:"All",
        triggers:[{
          Domain:"SmartPlug",
          Id:1,
          TargetName:"Kitchen plug",
          Get:"TargetState",
          Comparator:"Equals",
          CompareTo:{StringValue:"On"},
        }],
        actions:[
          {Wait:1},
          {
            Domain:"SmartPlug",
            Id:1,
            TargetName:"Kitchen plug",
            Action:"RequestOutput",
            Value:"Off",
          },
        ],
        time_constraints:[],
      },
    }],
  };
  panel._seedDrafts();

  const markup = panel._categoryContent("automations", true);

  assert.match(markup, /data-device-control data-category="automations" data-device-id="12"/);
  assert.match(markup, /Enable or disable this automation\./);
  assert.match(markup, /data-action="toggle-enabled" data-field="enabled" aria-pressed="true"/);
  assert.match(markup, /data-action="toggle-enabled" data-field="notification_enabled" aria-pressed="false"/);
  assert.doesNotMatch(markup, /type="checkbox"/);
  assert.match(markup, /When all of these are true/);
  assert.match(markup, /Kitchen plug is on/);
  assert.match(markup, /Wait 1 min/);
  assert.match(markup, /Turn Kitchen plug off/);
  assert.doesNotMatch(markup, /data-action="save-device"/);
  assert.match(markup, /class="status status-action danger" data-action="delete-automation"/);
  assert.match(markup, /class="heading-actions">[\s\S]*data-field="enabled"[\s\S]*data-action="delete-automation"/);
  assert.match(markup, /<h3>Notifications<\/h3>[\s\S]*notification-toggle-only[\s\S]*data-field="notification_enabled"/);
  assert.doesNotMatch(markup, /class="app-managed"/);
});

test("uses actionable status controls for every notification type", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._notifications = {
    equipment:[{
      equipment_id:1,
      name:"Smart plug",
      monitored:true,
      notifications:{under:{period_mins:5, limit:10, enabled:true}},
    }],
    smoke_alarms:[{device_id:2, name:"Smoke alarm", enabled:false}],
    sensors:[{device_id:3, name:"Window", enabled:true}],
    automations:[],
  };
  panel._seedDrafts();

  const equipment = panel._categoryContent("equipment", true);
  const smokeAlarm = panel._categoryContent("smoke_alarms", true);
  const sensor = panel._categoryContent("sensors", true);

  assert.match(equipment, /data-action="toggle-enabled" data-field="enabled" aria-pressed="true"/);
  assert.match(smokeAlarm, /data-action="toggle-enabled" data-field="enabled" aria-pressed="false"/);
  assert.match(sensor, /data-action="toggle-enabled" data-field="enabled" aria-pressed="true"/);
  assert.doesNotMatch(`${equipment}${smokeAlarm}${sensor}`, /type="checkbox"/);
});

test("status controls route notification and device changes to immediate saves", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  const saves = [];
  panel._saveNotificationEnabled = async section => { saves.push(["notification", section]); };
  panel._saveDevice = async (section, field) => { saves.push(["device", section, field]); };
  panel._drafts.set("1:over", {configured:true, period_mins:5, limit:100, enabled:true});
  panel._deviceDrafts.set("sensors:8", {enabled:false});
  const notificationSection = {dataset:{equipmentId:"1", notification:"over"}};
  const deviceSection = {dataset:{category:"sensors", deviceId:"8"}};

  await panel._toggleEnabled({
    disabled:false,
    dataset:{field:"enabled"},
    closest:selector => selector === "[data-notification]" ? notificationSection : null,
  });
  await panel._toggleEnabled({
    disabled:false,
    dataset:{field:"enabled"},
    closest:selector => selector === "[data-device-control]" ? deviceSection : null,
  });

  assert.equal(panel._drafts.get("1:over").enabled, false);
  assert.equal(panel._deviceDrafts.get("sensors:8").enabled, true);
  assert.deepEqual(saves, [
    ["notification", notificationSection],
    ["device", deviceSection, "enabled"],
  ]);
});

test("equipment status toggles preserve unsaved power values", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._notifications = {equipment:[], smoke_alarms:[], sensors:[], automations:[]};
  panel._originalDrafts.set("1:over", {
    configured:true, period_mins:5, limit:100, enabled:true,
  });
  panel._drafts.set("1:over", {
    configured:true, period_mins:7, limit:200, enabled:true,
  });
  let request;
  panel._hass = {
    user:{is_admin:true},
    callWS:async message => {
      request = message;
      return [{
        equipment_id:1,
        notifications:{
          under:null,
          over:{period_mins:5, limit:100, enabled:false},
        },
      }];
    },
  };
  const section = {dataset:{equipmentId:"1", notification:"over"}};

  await panel._toggleEnabled({
    disabled:false,
    dataset:{field:"enabled"},
    closest:selector => selector === "[data-notification]" ? section : null,
  });

  assert.deepEqual(plain(request), {
    type:"wiser/power_notification/set",
    hub:"Home",
    equipment_id:1,
    notification_type:"over",
    period_mins:5,
    limit:100,
    enabled:false,
  });
  assert.deepEqual(plain(panel._drafts.get("1:over")), {
    configured:true,
    period_mins:7,
    limit:200,
    enabled:false,
  });
});

test("failed immediate status updates restore the confirmed state", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._hass = {
    user:{is_admin:true},
    callWS:async () => { throw new Error("failed"); },
  };
  panel._originalDrafts.set("1:over", {
    configured:true, period_mins:5, limit:100, enabled:true,
  });
  panel._drafts.set("1:over", {
    configured:true, period_mins:7, limit:200, enabled:true,
  });
  panel._originalDeviceDrafts.set("sensors:8", {enabled:true});
  panel._deviceDrafts.set("sensors:8", {enabled:true});
  const notificationSection = {dataset:{equipmentId:"1", notification:"over"}};
  const deviceSection = {dataset:{category:"sensors", deviceId:"8"}};

  await panel._toggleEnabled({
    disabled:false,
    dataset:{field:"enabled"},
    closest:selector => selector === "[data-notification]" ? notificationSection : null,
  });
  await panel._toggleEnabled({
    disabled:false,
    dataset:{field:"enabled"},
    closest:selector => selector === "[data-device-control]" ? deviceSection : null,
  });

  assert.deepEqual(plain(panel._drafts.get("1:over")), {
    configured:true,
    period_mins:7,
    limit:200,
    enabled:true,
  });
  assert.equal(panel._deviceDrafts.get("sensors:8").enabled, true);
  assert.match(panel._error, /failed/);
});

test("formats Wiser automation waits as HHMM durations", () => {
  const {Panel} = setup();
  const panel = new Panel();

  assert.equal(panel._automationWait(1), "Wait 1 min");
  assert.equal(panel._automationWait(100), "Wait 1 h");
  assert.equal(panel._automationWait(103), "Wait 1 h 3 min");
});

test("automation status controls save immediately without Save buttons", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._notifications = {
    equipment:[], smoke_alarms:[], sensors:[],
    automations:[{
      automation_id:12,
      name:"Test",
      enabled:true,
      notification_enabled:true,
      writable:true,
      notification_writable:true,
      deletable:true,
    }],
  };
  panel._seedDrafts();
  const requests = [];
  panel._hass = {
    user:{is_admin:true},
    callWS:async message => {
      requests.push(message);
      return {
        equipment:[], smoke_alarms:[], sensors:[],
        automations:[{
          automation_id:12,
          name:"Test",
          enabled:false,
          notification_enabled:message.type === "wiser/automation/set_notification_enabled"
            ? message.enabled
            : true,
          writable:true,
          notification_writable:true,
          deletable:true,
        }],
      };
    },
  };
  const section = {dataset:{category:"automations", deviceId:"12"}};

  await panel._toggleEnabled({
    disabled:false,
    dataset:{field:"enabled"},
    closest:selector => selector === "[data-device-control]" ? section : null,
  });
  await panel._toggleEnabled({
    disabled:false,
    dataset:{field:"notification_enabled"},
    closest:selector => selector === "[data-device-control]" ? section : null,
  });
  const markup = panel._categoryContent("automations", true);

  assert.deepEqual(plain(requests), [
    {
      type:"wiser/automation/set_enabled",
      hub:"Home",
      automation_id:12,
      enabled:false,
    },
    {
      type:"wiser/automation/set_notification_enabled",
      hub:"Home",
      automation_id:12,
      enabled:false,
    },
  ]);
  assert.doesNotMatch(markup, /data-action="save-device"/);
  assert.match(markup, /data-action="delete-automation"/);
});

test("automation Delete remains in place while an enabled change is saving", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._notifications = {
    equipment:[], smoke_alarms:[], sensors:[],
    automations:[{
      automation_id:12,
      name:"Test",
      enabled:true,
      notification_enabled:true,
      writable:true,
      notification_writable:true,
      deletable:true,
    }],
  };
  panel._seedDrafts();
  panel._deviceDrafts.get("automations:12").enabled = false;
  panel._busy.add("automations:12");

  const markup = panel._categoryContent("automations", true);

  assert.match(markup, /data-action="delete-automation" disabled/);
  assert.doesNotMatch(markup, /data-action="delete-automation" hidden/);
});

test("keeps unsupported automation controls read-only", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._notifications = {
    equipment:[], smoke_alarms:[], sensors:[],
    automations:[{
      automation_id:12,
      name:"Door left open",
      enabled:true,
      writable:false,
    }],
  };

  const markup = panel._categoryContent("automations", true);

  assert.match(markup, /class="app-managed"/);
  assert.doesNotMatch(markup, /data-field="enabled"/);
});

test("saves notification layout settings through the shared panel API", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._config = {
    panel_id:"notifications",
    card_configs:{Home:{existing_setting:true}},
  };
  panel._settingsOpen = true;
  panel._settingsDraft = {
    columns:3,
    mobile_device_columns:1,
    item_order:{equipment:["2", "1"], sensors:["8"]},
  };
  let request;
  panel._hass = {callWS:async message => { request = message; }};

  await panel._saveSettings();

  assert.deepEqual(plain(request), {
    type:"wiser/panel/configure",
    panel_id:"notifications",
    configs:{Home:{
      existing_setting:true,
      columns:3,
      mobile_device_columns:1,
      item_order:{equipment:["2", "1"], sensors:["8"]},
    }},
  });
  assert.equal(panel._config.card_configs.Home.columns, 3);
  assert.equal(panel._config.card_configs.Home.mobile_device_columns, 1);
  assert.equal(panel._settingsOpen, false);
});

test("defaults mobile layouts to one device per row", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  panel._hass = {user:{is_admin:true}};
  panel._config = {
    panel_id:"notifications",
    card_configs:{Home:{columns:3}},
  };
  panel._notifications = {
    equipment:[], smoke_alarms:[], sensors:[], automations:[],
  };

  panel._openSettings();

  assert.equal(panel._settingsDraft.columns, 3);
  assert.equal(panel._settingsDraft.mobile_device_columns, 1);
});

test("renders separate desktop and mobile device column classes", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._loading = false;
  panel._hub = "Home";
  panel._hubs = ["Home"];
  panel._hass = {user:{is_admin:true}};
  panel._config = {
    card_configs:{Home:{columns:4, mobile_device_columns:2}},
  };
  panel._notifications = {
    equipment:[{equipment_id:1, name:"Plug", monitored:true, notifications:{}}],
    smoke_alarms:[], sensors:[], automations:[],
  };

  panel._render();

  assert.match(panel.shadowRoot.innerHTML, /columns-4 mobile-columns-2/);
});

test("uses the native Home Assistant form for desktop and mobile device columns", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._notifications = {
    equipment:[{equipment_id:1, name:"Plug", monitored:true, notifications:{}}],
    smoke_alarms:[], sensors:[], automations:[],
  };
  panel._settingsDraft = {columns:2, mobile_device_columns:1, item_order:{equipment:["1"]}};

  const markup = panel._settingsMarkup();

  assert.match(markup, /<ha-form class="column-setting"><\/ha-form>/);
  assert.doesNotMatch(markup, /<ha-selector/);
  assert.doesNotMatch(markup, /<select/);
});

test("uses tabs to configure one notification category at a time", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._settingsCategory = "equipment";
  panel._notifications = {
    equipment:[{equipment_id:1, name:"Plug", monitored:true, notifications:{}}],
    smoke_alarms:[],
    sensors:[{device_id:8, name:"Sensor"}],
    automations:[],
  };
  panel._settingsDraft = {
    columns:2,
    item_order:{equipment:["1"], sensors:["8"]},
  };

  const equipmentMarkup = panel._settingsMarkup();
  assert.match(equipmentMarkup, /class="settings-category-tabs" role="tablist"/);
  assert.match(equipmentMarkup, /data-category="equipment" role="tab" aria-selected="true"/);
  assert.match(equipmentMarkup, /data-category="sensors" role="tab" aria-selected="false"/);
  assert.match(equipmentMarkup, />Plug<\/span>/);
  assert.doesNotMatch(equipmentMarkup, />Sensor<\/span>/);

  panel._settingsCategory = "sensors";
  const sensorMarkup = panel._settingsMarkup();
  assert.match(sensorMarkup, /data-category="sensors" role="tab" aria-selected="true"/);
  assert.match(sensorMarkup, />Sensor<\/span>/);
  assert.doesNotMatch(sensorMarkup, />Plug<\/span>/);
});

test("switches settings tabs without rerendering or closing the dialog", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._settingsOpen = true;
  panel._settingsCategory = "smoke_alarms";
  panel._notifications = {
    equipment:[{equipment_id:1, name:"Plug", monitored:true, notifications:{}}],
    smoke_alarms:[{device_id:7, name:"Smoke alarm"}],
    sensors:[], automations:[],
  };
  panel._settingsDraft = {
    columns:2,
    item_order:{equipment:["1"], smoke_alarms:["7"]},
  };
  let renders = 0;
  panel._renderSoon = () => { renders += 1; };
  const tabs = ["equipment", "smoke_alarms"].map(category => ({
    dataset:{category},
    selected:null,
    setAttribute(name, value) {
      if (name === "aria-selected") this.selected = value;
    },
  }));
  const orderSection = {innerHTML:""};
  panel.shadowRoot.querySelector = selector => selector === "#settings-dialog"
    ? {
        querySelectorAll:() => tabs,
        querySelector:() => orderSection,
      }
    : null;

  panel._selectSettingsCategory("equipment");

  assert.equal(panel._settingsOpen, true);
  assert.equal(panel._settingsCategory, "equipment");
  assert.equal(renders, 0);
  assert.equal(tabs[0].selected, "true");
  assert.equal(tabs[1].selected, "false");
  assert.match(orderSection.innerHTML, />Plug<\/span>/);
});

test("shows panel version information in settings", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._notifications = {
    equipment:[], smoke_alarms:[], sensors:[], automations:[],
  };
  panel._settingsDraft = {columns:2, item_order:{}};

  assert.match(
    panel._settingsMarkup(),
    /class="settings-version">Wiser Notifications Panel · __WISER_NOTIFICATIONS_PANEL_VERSION__<\/div>/,
  );
});

test("tracks changed settings and keeps unchanged saves disabled", () => {
  const {Panel} = setup();
  const panel = new Panel();
  const original = {configured:true, period_mins:5, limit:100, enabled:true};
  panel._drafts.set("1:over", {...original});
  panel._originalDrafts.set("1:over", {...original});

  assert.equal(panel._isDirty("1:over"), false);
  panel._drafts.get("1:over").limit = 250;
  assert.equal(panel._isDirty("1:over"), true);
  panel._drafts.get("1:over").limit = 100;
  assert.equal(panel._isDirty("1:over"), false);
});

test("changing an existing power value makes Save actionable", () => {
  const {Panel} = setup();
  const panel = new Panel();
  const original = {configured:true, period_mins:5, limit:100, enabled:true};
  panel._drafts.set("1:over", {...original});
  panel._originalDrafts.set("1:over", {...original});
  let disabled = true;
  let hidden = true;
  const save = {
    toggleAttribute:(name, value) => {
      if (name === "disabled") disabled = value;
    },
  };
  const footer = {
    toggleAttribute:(name, value) => {
      if (name === "hidden") hidden = value;
    },
  };
  const section = {
    dataset:{equipmentId:"1", notification:"over"},
    querySelector:selector => selector.includes("save") ? save : footer,
  };
  const input = {
    dataset:{field:"limit"},
    value:"250",
    closest:selector => selector === "[data-field]" ? input : section,
  };

  panel._input({type:"change", target:input});

  assert.equal(panel._drafts.get("1:over").limit, 250);
  assert.equal(panel._isDirty("1:over"), true);
  assert.equal(disabled, false);
  assert.equal(hidden, false);
});

test("configured notifications use a destructive delete button", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._hass = {user:{is_admin:true}};
  const draft = {configured:true, period_mins:5, limit:100, enabled:true};
  panel._drafts.set("1:over", {...draft});
  panel._originalDrafts.set("1:over", {...draft});

  const markup = panel._notification({equipment_id:1}, "over", true);

  assert.match(markup, /data-action="delete"/);
  assert.match(markup, /class="notification-heading-actions">[\s\S]*data-field="enabled"[\s\S]*class="status status-action danger" data-action="delete"/);
  assert.match(markup, /class="notification-footer" hidden/);
  assert.doesNotMatch(markup, /<ha-button variant="danger" data-action="delete"/);
});

test("opens a native Home Assistant equipment notification delete dialog", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._hass = {user:{is_admin:true}};
  const dialog = {open:false};
  panel.shadowRoot.querySelector = selector => selector === "#notification-delete-dialog" ? dialog : null;

  panel._openNotificationDelete({dataset:{equipmentId:"1", notification:"over"}});

  assert.deepEqual(plain(panel._notificationDelete), {equipmentId:1, type:"over"});
  assert.equal(dialog.open, true);
});

test("renders native Home Assistant equipment notification delete actions", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._render();

  assert.match(panel.shadowRoot.innerHTML, /<ha-dialog id="notification-delete-dialog" width="medium">/);
  assert.match(panel.shadowRoot.innerHTML, /class="delete-confirmation">Delete this native Wiser notification\?/);
  assert.match(panel.shadowRoot.innerHTML, /variant="danger" data-action="delete-notification-confirm">Delete/);
});

test("keeps the equipment notification delete dialog open across refreshes", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._notificationDelete = {equipmentId:1, type:"under"};
  const dialog = {
    open:false,
    setAttribute() {},
    addEventListener() {},
    querySelector() { return null; },
  };
  panel.shadowRoot.querySelector = selector => selector === "#notification-delete-dialog" ? dialog : null;

  panel._render();

  assert.equal(dialog.open, true);
  assert.deepEqual(plain(panel._notificationDelete), {equipmentId:1, type:"under"});
});

test("deletes the selected native notification", async () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._renderSoon = () => {};
  panel._hub = "Home";
  let request;
  panel._hass = {
    user:{is_admin:true},
    callWS:async message => {
      request = message;
      return [];
    },
  };
  await panel._deleteNotification(1, "under");
  assert.deepEqual(plain(request), {
    type:"wiser/power_notification/delete",
    hub:"Home",
    equipment_id:1,
    notification_type:"under",
  });
});

