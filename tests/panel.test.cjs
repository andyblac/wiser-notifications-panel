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
  assert.equal(helpers.localize("panel.title", {language:"de"}), "Wiser-Benachrichtigungen");
  assert.equal(helpers.localize("panel.title", {language:"es"}), "Notificaciones Wiser");
  assert.equal(helpers.localize("panel.title", {language:"it"}), "Wiser Notifications");
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
  });

  assert.deepEqual(plain(request), {
    type:"wiser/device_notification/set",
    hub:"Home",
    category:"sensor",
    device_id:8,
    enabled:false,
  });
  assert.equal(panel._deviceDrafts.get("sensors:8").enabled, false);
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
  assert.match(markup, /appearance="outlined" variant="danger"/);
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

