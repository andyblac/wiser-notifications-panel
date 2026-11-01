/* Native Wiser power notification management panel. */
(() => {
  const VERSION = "__WISER_NOTIFICATIONS_PANEL_VERSION__";
  const TRANSLATIONS = __WISER_NOTIFICATIONS_TRANSLATIONS__;
  const selectedHubs = new Map();
  const TYPES = ["under", "over"];

  const esc = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
  })[character]);

  function languageFor(hass) {
    const language = (
      hass?.locale?.language
      || hass?.language
      || (typeof document !== "undefined" ? document.documentElement?.lang : "")
      || "en-US"
    ).replace(/_/g, "-").toLowerCase();
    if (language === "en-gb") return "en-GB";
    const supported = {
      da:"da", de:"de", es:"es", fi:"fi", fr:"fr", hu:"hu",
      nb:"nb", no:"nb", nl:"nl", pt:"pt", sv:"sv",
    };
    const matched = supported[language.split("-")[0]];
    if (matched) return matched;
    return "en-US";
  }

  function localize(key, hass, values = {}) {
    const language = languageFor(hass);
    const translated = TRANSLATIONS[language]?.[key]
      || TRANSLATIONS["en-US"]?.[key]
      || key;
    return translated.replace(/\{(\w+)\}/g, (token, name) => String(values[name] ?? token));
  }

  function notificationDraft(notification, type) {
    return {
      configured:Boolean(notification),
      period_mins:notification?.period_mins ?? 5,
      limit:notification?.limit ?? (type === "under" ? 0 : 100),
      enabled:notification?.enabled ?? true,
    };
  }

  function compatibleEquipment(equipment) {
    return equipment.filter(item => item.monitored || TYPES.some(type => item.notifications?.[type]));
  }

  class WiserNotificationsPanel extends HTMLElement {
    static panelApiVersion = 1;

    constructor() {
      super();
      this.attachShadow({mode:"open"});
      this._config = {};
      this._hubs = [];
      this._hub = "";
      this._equipment = [];
      this._drafts = new Map();
      this._busy = new Set();
      this._loading = true;
      this._error = "";
      this._message = "";
      this._renderFrame = 0;
      this.shadowRoot.addEventListener("click", event => this._click(event));
      this.shadowRoot.addEventListener("input", event => this._input(event));
      this.shadowRoot.addEventListener("change", event => this._input(event));
    }

    set hass(value) {
      const first = !this._hass;
      const connectionChanged = this._hass?.connection && this._hass.connection !== value?.connection;
      this._hass = value;
      if ((first || connectionChanged) && this.isConnected) this._load();
      else this._renderSoon();
    }

    set panel(value) {
      const config = value?.config || {};
      if (JSON.stringify(config) === JSON.stringify(this._config)) return;
      this._config = config;
      const hubs = Array.isArray(config.hubs) ? config.hubs : [];
      this._hubs = [...hubs];
      const remembered = config.panel_id ? selectedHubs.get(config.panel_id) : undefined;
      if (!this._hubs.includes(this._hub)) {
        this._hub = this._hubs.includes(remembered) ? remembered : this._hubs[0] || "";
      }
      if (this._hass && this.isConnected) this._load();
    }

    set narrow(value) {
      this.toggleAttribute("narrow", Boolean(value));
    }

    set route(value) {
      this._route = value;
    }

    connectedCallback() {
      this._renderSoon();
      if (this._hass) this._load();
    }

    disconnectedCallback() {
      if (this._renderFrame) cancelAnimationFrame(this._renderFrame);
      this._renderFrame = 0;
    }

    _t(key, values) {
      return localize(key, this._hass, values);
    }

    _key(equipmentId, type) {
      return `${equipmentId}:${type}`;
    }

    _seedDrafts() {
      const next = new Map();
      for (const equipment of this._equipment) {
        for (const type of TYPES) {
          const key = this._key(equipment.equipment_id, type);
          next.set(key, notificationDraft(equipment.notifications?.[type], type));
        }
      }
      this._drafts = next;
    }

    async _load(silent = false) {
      if (!this._hass?.callWS) return;
      if (!silent) {
        this._loading = true;
        this._error = "";
        this._renderSoon();
      }
      try {
        if (!this._hubs.length) {
          this._hubs = await this._hass.callWS({type:"wiser/hubs"});
        }
        if (!this._hubs.includes(this._hub)) this._hub = this._hubs[0] || "";
        if (!this._hub) throw new Error("No Wiser hub is available");
        this._equipment = await this._hass.callWS({
          type:"wiser/power_notifications",
          hub:this._hub,
        });
        this._seedDrafts();
        this._error = "";
      } catch (error) {
        this._error = this._t("panel.load_error", {error:error?.message || error});
      } finally {
        this._loading = false;
        this._renderSoon();
      }
    }

    _selectHub(hub) {
      if (!this._hubs.includes(hub) || hub === this._hub) return;
      this._hub = hub;
      if (this._config.panel_id) selectedHubs.set(this._config.panel_id, hub);
      this._equipment = [];
      this._drafts.clear();
      this._load();
    }

    _input(event) {
      const input = event.target?.closest?.("[data-field]");
      const section = input?.closest?.("[data-notification]");
      if (!input || !section) return;
      const key = this._key(Number(section.dataset.equipmentId), section.dataset.notification);
      const draft = this._drafts.get(key);
      if (!draft) return;
      if (input.dataset.field === "enabled") draft.enabled = input.checked;
      else draft[input.dataset.field] = Number(input.value);
    }

    _notify(message) {
      this._message = message;
      this.dispatchEvent(new CustomEvent("hass-notification", {
        bubbles:true,
        composed:true,
        detail:{message},
      }));
    }

    async _save(section) {
      if (!this._hass?.user?.is_admin) return;
      const equipmentId = Number(section.dataset.equipmentId);
      const type = section.dataset.notification;
      const key = this._key(equipmentId, type);
      const inputs = [...section.querySelectorAll("input[data-field]")];
      if (!inputs.every(input => input.reportValidity())) return;
      const draft = this._drafts.get(key);
      if (!draft || !Number.isInteger(draft.period_mins) || !Number.isInteger(draft.limit)) return;
      this._busy.add(key);
      this._error = "";
      this._renderSoon();
      try {
        this._equipment = await this._hass.callWS({
          type:"wiser/power_notification/set",
          hub:this._hub,
          equipment_id:equipmentId,
          notification_type:type,
          period_mins:draft.period_mins,
          limit:draft.limit,
          enabled:draft.enabled,
        });
        this._seedDrafts();
        this._notify(this._t("panel.saved"));
      } catch (error) {
        this._error = this._t("panel.save_error", {error:error?.message || error});
      } finally {
        this._busy.delete(key);
        this._renderSoon();
      }
    }

    async _delete(section) {
      if (!this._hass?.user?.is_admin) return;
      if (!window.confirm(this._t("panel.confirm_delete"))) return;
      const equipmentId = Number(section.dataset.equipmentId);
      const type = section.dataset.notification;
      const key = this._key(equipmentId, type);
      this._busy.add(key);
      this._error = "";
      this._renderSoon();
      try {
        this._equipment = await this._hass.callWS({
          type:"wiser/power_notification/delete",
          hub:this._hub,
          equipment_id:equipmentId,
          notification_type:type,
        });
        this._seedDrafts();
        this._notify(this._t("panel.deleted"));
      } catch (error) {
        this._error = this._t("panel.delete_error", {error:error?.message || error});
      } finally {
        this._busy.delete(key);
        this._renderSoon();
      }
    }

    _click(event) {
      const target = event.target?.closest?.("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action === "menu") {
        this.dispatchEvent(new CustomEvent("hass-toggle-menu", {bubbles:true, composed:true}));
      } else if (action === "refresh" || action === "retry") this._load();
      else if (action === "hub") this._selectHub(target.dataset.hub);
      else if (action === "save") this._save(target.closest("[data-notification]"));
      else if (action === "delete") this._delete(target.closest("[data-notification]"));
    }

    _notification(equipment, type, admin) {
      const key = this._key(equipment.equipment_id, type);
      const draft = this._drafts.get(key) || notificationDraft(null, type);
      const busy = this._busy.has(key);
      const disabled = !admin || busy ? " disabled" : "";
      const configured = draft.configured;
      return `<section class="notification" data-notification="${type}" data-equipment-id="${equipment.equipment_id}">
        <div class="notification-heading">
          <div class="notification-icon ${type}"><ha-icon icon="${type === "under" ? "mdi:trending-down" : "mdi:trending-up"}"></ha-icon></div>
          <div><h3>${esc(this._t(`notification.${type}`))}</h3>
            <p>${esc(this._t(`notification.${type}_description`))}</p></div>
          <span class="status ${configured ? "configured" : ""}">${esc(this._t(configured ? "notification.configured" : "notification.not_configured"))}</span>
        </div>
        <div class="fields">
          <label><span>${esc(this._t("notification.limit"))}</span>
            <span class="number-field"><input data-field="limit" type="number" min="0" step="1" required value="${draft.limit}"${disabled}>
              <span>${esc(this._t("notification.watts"))}</span></span></label>
          <label><span>${esc(this._t("notification.period"))}</span>
            <span class="number-field"><input data-field="period_mins" type="number" min="0" step="1" required value="${draft.period_mins}"${disabled}>
              <span>${esc(this._t("notification.minutes"))}</span></span></label>
          <label class="enabled"><input data-field="enabled" type="checkbox"${draft.enabled ? " checked" : ""}${disabled}>
            <span>${esc(this._t("notification.enabled"))}</span></label>
        </div>
        ${admin ? `<div class="actions">
          ${configured ? `<ha-button appearance="plain" data-action="delete"${disabled}>${esc(this._t("action.delete"))}</ha-button>` : ""}
          <ha-button data-action="save"${disabled}>${busy ? `<ha-circular-progress active size="small"></ha-circular-progress>` : esc(this._t(configured ? "action.save" : "action.create"))}</ha-button>
        </div>` : ""}
      </section>`;
    }

    _equipmentCard(equipment, admin) {
      const detail = [equipment.device_type, equipment.family].filter(Boolean).join(" · ");
      return `<article class="equipment-card">
        <header class="equipment-heading">
          <div class="equipment-icon"><ha-icon icon="mdi:power-plug"></ha-icon></div>
          <div><h2>${esc(equipment.name || `${equipment.device_type} ${equipment.equipment_id}`)}</h2>
            <p>${esc(detail)}</p></div>
          <span class="monitoring">${esc(this._t(equipment.monitored ? "equipment.monitored" : "equipment.not_monitored"))}</span>
        </header>
        <div class="notification-grid">
          ${TYPES.map(type => this._notification(equipment, type, admin)).join("")}
        </div>
      </article>`;
    }

    _style() {
      return `<style>
        :host { display:block; min-height:100%; color:var(--primary-text-color); background:var(--primary-background-color); font-family:var(--ha-font-family-body, sans-serif); }
        * { box-sizing:border-box; }
        .app-header { position:sticky; top:0; z-index:3; display:flex; align-items:center; min-height:64px; gap:12px; padding:0 16px; color:var(--app-header-text-color); background:var(--app-header-background-color); box-shadow:var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,.16)); }
        .app-header h1 { margin:0; font-size:20px; font-weight:400; white-space:nowrap; }
        .icon-button { display:grid; place-items:center; width:44px; height:44px; border:0; border-radius:50%; color:inherit; background:transparent; cursor:pointer; }
        .icon-button:hover { background:rgba(127,127,127,.15); }
        .hub-tabs { align-self:stretch; display:flex; flex:1; overflow:auto; margin-inline-start:16px; }
        .hub-tab { padding:0 22px; border:0; border-bottom:2px solid transparent; color:var(--secondary-text-color); background:transparent; font:inherit; cursor:pointer; }
        .hub-tab[aria-selected="true"] { color:var(--app-header-text-color, var(--primary-text-color)); border-bottom-color:currentColor; }
        :host([nested]) .app-header { min-height:56px; }
        :host([nested]) .menu-button, :host([nested]) .app-header h1 { display:none; }
        :host([nested]) .hub-tabs { margin-inline-start:0; }
        :host([nested]) .app-header.single-hub { display:none; }
        main { width:min(1500px, 100%); margin:0 auto; padding:28px clamp(12px, 3vw, 40px) 48px; }
        .hero { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:24px; }
        .hero h2 { margin:0 0 6px; font-size:28px; line-height:1.2; }
        .hero p { margin:0; color:var(--secondary-text-color); }
        .refresh { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
        .message { padding:22px; border-radius:16px; background:var(--ha-card-background, var(--card-background-color)); box-shadow:var(--ha-card-box-shadow); }
        .message.error { color:var(--error-color, #db4437); border-inline-start:4px solid currentColor; }
        .read-only { margin:0 0 16px; padding:12px 16px; border-radius:12px; color:var(--warning-color, #f0a000); background:color-mix(in srgb, currentColor 10%, transparent); }
        .equipment-list { display:grid; gap:20px; }
        .equipment-card { overflow:hidden; border-radius:18px; background:var(--ha-card-background, var(--card-background-color)); box-shadow:var(--ha-card-box-shadow); }
        .equipment-heading { display:flex; align-items:center; gap:14px; padding:20px 22px; border-bottom:1px solid var(--divider-color); }
        .equipment-heading h2 { margin:0; font-size:20px; }
        .equipment-heading p { margin:4px 0 0; color:var(--secondary-text-color); font-size:13px; }
        .equipment-icon, .notification-icon { display:grid; place-items:center; flex:0 0 auto; border-radius:14px; color:var(--primary-color); background:color-mix(in srgb, var(--primary-color) 12%, transparent); }
        .equipment-icon { width:46px; height:46px; }
        .notification-icon { width:40px; height:40px; }
        .notification-icon.under { color:var(--info-color, #039be5); background:color-mix(in srgb, currentColor 12%, transparent); }
        .notification-icon.over { color:var(--warning-color, #f0a000); background:color-mix(in srgb, currentColor 12%, transparent); }
        .monitoring { margin-inline-start:auto; padding:5px 9px; border-radius:999px; color:var(--secondary-text-color); background:var(--secondary-background-color); font-size:12px; }
        .notification-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); }
        .notification { min-width:0; padding:22px; }
        .notification + .notification { border-inline-start:1px solid var(--divider-color); }
        .notification-heading { display:grid; grid-template-columns:auto minmax(0, 1fr); align-items:start; gap:12px; min-height:100px; }
        .notification-heading h3 { margin:0 0 5px; font-size:17px; }
        .notification-heading p { margin:0; color:var(--secondary-text-color); font-size:13px; line-height:1.45; }
        .status { grid-column:2; justify-self:start; padding:4px 8px; border-radius:999px; color:var(--secondary-text-color); background:var(--secondary-background-color); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
        .status.configured { color:var(--success-color, #43a047); background:color-mix(in srgb, currentColor 12%, transparent); }
        .fields { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:18px; }
        .fields label { display:grid; gap:7px; color:var(--secondary-text-color); font-size:13px; }
        .number-field { display:flex; align-items:center; overflow:hidden; min-height:44px; border:1px solid var(--divider-color); border-radius:10px; background:var(--primary-background-color); }
        .number-field:focus-within { border-color:var(--primary-color); box-shadow:0 0 0 1px var(--primary-color); }
        .number-field input { width:100%; min-width:0; padding:10px 12px; border:0; outline:0; color:var(--primary-text-color); background:transparent; font:inherit; font-size:16px; }
        .number-field > span { padding:0 12px; color:var(--secondary-text-color); white-space:nowrap; }
        .enabled { grid-column:1 / -1; display:flex !important; align-items:center; gap:9px !important; min-height:34px; color:var(--primary-text-color) !important; }
        .enabled input { width:19px; height:19px; margin:0; accent-color:var(--primary-color); }
        input:disabled { opacity:.6; }
        .actions { display:flex; justify-content:flex-end; gap:8px; min-height:44px; margin-top:14px; }
        .actions ha-circular-progress { --mdc-theme-primary:currentColor; }
        @media (max-width:800px) {
          .app-header { padding:0 8px; gap:4px; }
          .app-header h1 { font-size:16px; }
          .hub-tabs { margin-inline-start:0; }
          .hub-tab { padding:0 12px; }
          main { padding-top:20px; }
          .hero h2 { font-size:24px; }
          .notification-grid { grid-template-columns:1fr; }
          .notification + .notification { border-inline-start:0; border-top:1px solid var(--divider-color); }
        }
        @media (max-width:500px) {
          .hero { align-items:center; }
          .refresh span { display:none; }
          .equipment-heading { align-items:flex-start; padding:18px; }
          .monitoring { display:none; }
          .notification { padding:18px; }
          .fields { grid-template-columns:1fr; }
          .enabled { grid-column:1; }
        }
      </style>`;
    }

    _renderSoon() {
      if (this._renderFrame) return;
      this._renderFrame = requestAnimationFrame(() => {
        this._renderFrame = 0;
        this._render();
      });
    }

    _render() {
      const admin = Boolean(this._hass?.user?.is_admin);
      const hubs = this._hubs;
      const tabs = hubs.length > 1 ? `<nav class="hub-tabs" role="tablist" aria-label="${esc(this._t("panel.hubs"))}">
        ${hubs.map(hub => `<button class="hub-tab" data-action="hub" data-hub="${esc(hub)}" role="tab" aria-selected="${hub === this._hub}">${esc(hub)}</button>`).join("")}
      </nav>` : `<div class="hub-tabs"></div>`;
      const headerClass = hubs.length <= 1 ? "app-header single-hub" : "app-header";
      let content;
      if (this._loading) content = `<p class="message" role="status">${esc(this._t("panel.loading"))}</p>`;
      else if (this._error) content = `<div class="message error" role="alert">${esc(this._error)}<br><ha-button data-action="retry">${esc(this._t("panel.retry"))}</ha-button></div>`;
      else {
        const equipment = compatibleEquipment(this._equipment);
        content = `${admin ? "" : `<p class="read-only">${esc(this._t("panel.read_only"))}</p>`}
          ${equipment.length ? `<div class="equipment-list">${equipment.map(item => this._equipmentCard(item, admin)).join("")}</div>` : `<p class="message">${esc(this._t("panel.empty"))}</p>`}`;
      }
      this.shadowRoot.innerHTML = `${this._style()}
        <header class="${headerClass}">
          <button class="icon-button menu-button" data-action="menu" aria-label="${esc(this._t("panel.menu"))}"><ha-icon icon="mdi:menu"></ha-icon></button>
          <h1>${esc(this._t("panel.title"))}</h1>${tabs}
        </header>
        <main>
          <div class="hero"><div><h2>${esc(this._t("panel.title"))}</h2><p>${esc(this._t("panel.subtitle"))}</p></div>
            <ha-button class="refresh" appearance="plain" data-action="refresh"><ha-icon icon="mdi:refresh"></ha-icon><span>${esc(this._t("panel.refresh"))}</span></ha-button></div>
          <div aria-live="polite">${content}</div>
        </main>`;
    }
  }

  window.WiserNotificationsPanelTest = {
    compatibleEquipment,
    languageFor,
    localize,
    notificationDraft,
  };
  if (!customElements.get("wiser-notifications-panel")) {
    customElements.define("wiser-notifications-panel", WiserNotificationsPanel);
  }
  console.info(`%c WISER-NOTIFICATIONS-PANEL %c ${VERSION} `, "color:#fff;background:#43a047;font-weight:700", "color:#43a047;background:#fff");
})();
