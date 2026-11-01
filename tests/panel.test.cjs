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
      assert.deepEqual(plain(message), {type:"wiser/power_notifications", hub:"Home"});
      return [{equipment_id:1, monitored:true, notifications:{under:null, over:null}}];
    },
  };
  await panel._load();
  assert.equal(panel._equipment.length, 1);
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

