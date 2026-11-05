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
    window:{confirm:() => true},
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

test("shows tabs only for notification categories reported by the hub", () => {
  const {helpers} = setup();
  const notifications = {
    equipment:[{equipment_id:1, monitored:true, notifications:{}}],
    smoke_alarms:[],
    sensors:[{device_id:2, enabled:true}],
    automations:[],
  };

  assert.deepEqual(
    Array.from(helpers.availableCategories(notifications)),
    ["equipment", "sensors"],
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

test("silent updates preserve unsaved automation checkbox changes", async () => {
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

test("renders writable automations with enabled controls", () => {
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
  assert.match(markup, /data-field="enabled" type="checkbox" checked/);
  assert.match(markup, /data-field="notification_enabled" type="checkbox"/);
  assert.match(markup, /Receive a notification when this automation runs\./);
  assert.match(markup, /When all of these are true/);
  assert.match(markup, /Kitchen plug is on/);
  assert.match(markup, /Wait 1 s/);
  assert.match(markup, /Turn Kitchen plug off/);
  assert.match(markup, /data-action="save-device"/);
  assert.match(markup, /data-save-field="enabled"/);
  assert.match(markup, /data-save-field="notification_enabled"/);
  assert.match(markup, /variant="danger" data-action="delete-automation"/);
  assert.match(markup, /class="automation-controls">[\s\S]*data-action="delete-automation"/);
  assert.match(markup, /<h3>Automation<\/h3>[\s\S]*data-action="delete-automation"[\s\S]*<h3>Notifications<\/h3>/);
  assert.doesNotMatch(markup, /class="app-managed"/);
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
      item_order:{equipment:["2", "1"], sensors:["8"]},
    }},
  });
  assert.equal(panel._config.card_configs.Home.columns, 3);
  assert.equal(panel._settingsOpen, false);
});

test("uses the native Home Assistant form for desktop device columns", () => {
  const {Panel} = setup();
  const panel = new Panel();
  panel._notifications = {
    equipment:[{equipment_id:1, name:"Plug", monitored:true, notifications:{}}],
    smoke_alarms:[], sensors:[], automations:[],
  };
  panel._settingsDraft = {columns:2, item_order:{equipment:["1"]}};

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

test("changing an existing enabled toggle makes Save actionable", () => {
  const {Panel} = setup();
  const panel = new Panel();
  const original = {configured:true, period_mins:5, limit:100, enabled:true};
  panel._drafts.set("1:over", {...original});
  panel._originalDrafts.set("1:over", {...original});
  let disabled = true;
  let hidden = true;
  let deleteHidden = false;
  const save = {
    toggleAttribute:(name, value) => {
      if (name === "disabled") disabled = value;
      if (name === "hidden") hidden = value;
    },
  };
  const remove = {
    toggleAttribute:(name, value) => {
      if (name === "hidden") deleteHidden = value;
    },
  };
  const section = {
    dataset:{equipmentId:"1", notification:"over"},
    querySelector:selector => selector.includes("save") ? save : remove,
  };
  const input = {
    dataset:{field:"enabled"},
    checked:false,
    closest:selector => selector === "[data-field]" ? input : section,
  };

  panel._input({type:"change", target:input});

  assert.equal(panel._drafts.get("1:over").enabled, false);
  assert.equal(panel._isDirty("1:over"), true);
  assert.equal(disabled, false);
  assert.equal(hidden, false);
  assert.equal(deleteHidden, true);
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
  assert.match(markup, /<ha-button variant="danger" data-action="delete"/);
  assert.match(markup, /data-action="save" hidden disabled/);
  assert.doesNotMatch(markup, /data-action="delete" hidden/);
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
  await panel._delete({dataset:{equipmentId:"1", notification:"under"}});
  assert.deepEqual(plain(request), {
    type:"wiser/power_notification/delete",
    hub:"Home",
    equipment_id:1,
    notification_type:"under",
  });
});

