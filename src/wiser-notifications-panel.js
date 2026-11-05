/* Native Wiser notification management panel. */
(() => {
  const VERSION = "__WISER_NOTIFICATIONS_PANEL_VERSION__";
  const TRANSLATIONS = __WISER_NOTIFICATIONS_TRANSLATIONS__;
  const selectedHubs = new Map();
  const TYPES = ["under", "over"];
  const CATEGORY_ORDER = ["equipment", "smoke_alarms", "sensors", "automations"];

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

  function availableCategories(notifications) {
    return CATEGORY_ORDER.filter(category => {
      const items = notifications?.[category] || [];
      return category === "equipment" ? compatibleEquipment(items).length : items.length;
    });
  }

  function localizedCategories(notifications, hass) {
    const collator = new Intl.Collator(languageFor(hass), {sensitivity:"base"});
    return availableCategories(notifications).sort((left, right) => collator.compare(
      localize(`category.${left}`, hass),
      localize(`category.${right}`, hass),
    ));
  }

  function deviceColumns(value) {
    const columns = Number(value);
    return [1, 2, 3, 4].includes(columns) ? columns : 2;
  }

  function itemId(category, item) {
    if (category === "equipment") return String(item.equipment_id);
    if (category === "automations") return String(item.automation_id);
    return String(item.device_id);
  }

  function orderedItems(category, items, order) {
    const positions = new Map((Array.isArray(order) ? order : [])
      .map((id, index) => [String(id), index]));
    return items.map((item, index) => ({item, index}))
      .sort((left, right) => (
        (positions.get(itemId(category, left.item)) ?? Number.MAX_SAFE_INTEGER)
        - (positions.get(itemId(category, right.item)) ?? Number.MAX_SAFE_INTEGER)
        || left.index - right.index
      ))
      .map(({item}) => item);
  }

  class WiserNotificationsPanel extends HTMLElement {
    static panelApiVersion = 1;

    constructor() {
      super();
      this.attachShadow({mode:"open"});
      this._config = {};
      this._hubs = [];
      this._hub = "";
      this._notifications = {
        equipment:[],
        smoke_alarms:[],
        sensors:[],
        automations:[],
      };
      this._category = "equipment";
      this._drafts = new Map();
      this._originalDrafts = new Map();
      this._deviceDrafts = new Map();
      this._originalDeviceDrafts = new Map();
      this._busy = new Set();
      this._loading = true;
      this._error = "";
      this._message = "";
      this._settingsOpen = false;
      this._settingsDraft = null;
      this._settingsCategory = "";
      this._settingsError = "";
      this._savingSettings = false;
      this._draggedItem = null;
      this._renderFrame = 0;
      this._subscriptionConnection = null;
      this._unsubscribeUpdates = null;
      this._subscriptionGeneration = 0;
      this.shadowRoot.addEventListener("click", event => this._click(event));
      this.shadowRoot.addEventListener("input", event => this._input(event));
      this.shadowRoot.addEventListener("change", event => this._input(event));
      this.shadowRoot.addEventListener("dragstart", event => this._settingsDragStart(event));
      this.shadowRoot.addEventListener("dragover", event => this._settingsDragOver(event));
      this.shadowRoot.addEventListener("drop", event => this._settingsDrop(event));
      this.shadowRoot.addEventListener("dragend", () => this._clearSettingsDrag());
    }

    set hass(value) {
      const first = !this._hass;
      const connectionChanged = this._hass?.connection && this._hass.connection !== value?.connection;
      const languageChanged = !first && languageFor(this._hass) !== languageFor(value);
      const adminChanged = !first
        && Boolean(this._hass?.user?.is_admin) !== Boolean(value?.user?.is_admin);
      this._hass = value;
      if ((first || connectionChanged) && this.isConnected) {
        this._subscribeUpdates();
        this._load();
      }
      else if (languageChanged || adminChanged) this._renderSoon();
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
      if (this._hass) {
        this._subscribeUpdates();
        this._load();
      }
    }

    disconnectedCallback() {
      this._unsubscribeFromUpdates();
      if (this._renderFrame) cancelAnimationFrame(this._renderFrame);
      this._renderFrame = 0;
    }

    _unsubscribeFromUpdates() {
      this._subscriptionGeneration += 1;
      this._unsubscribeUpdates?.();
      this._unsubscribeUpdates = null;
      this._subscriptionConnection = null;
    }

    async _subscribeUpdates() {
      const connection = this._hass?.connection;
      if (!this.isConnected || !connection?.subscribeMessage) return;
      if (this._subscriptionConnection === connection) return;
      this._unsubscribeFromUpdates();
      this._subscriptionConnection = connection;
      const generation = this._subscriptionGeneration;
      try {
        const unsubscribe = await connection.subscribeMessage(event => {
          const hub = event?.hub ?? event?.event?.hub;
          if (!hub || !this._hub || hub === this._hub) this._load(true);
        }, {type:"wiser_updated"});
        if (generation !== this._subscriptionGeneration
          || connection !== this._hass?.connection
          || !this.isConnected) {
          unsubscribe?.();
          return;
        }
        this._unsubscribeUpdates = unsubscribe;
      } catch (_error) {
        if (generation === this._subscriptionGeneration) {
          this._subscriptionConnection = null;
        }
      }
    }

    _t(key, values) {
      return localize(key, this._hass, values);
    }

    _key(equipmentId, type) {
      return `${equipmentId}:${type}`;
    }

    _seedDrafts() {
      const next = new Map();
      const originals = new Map();
      for (const equipment of this._notifications.equipment) {
        for (const type of TYPES) {
          const key = this._key(equipment.equipment_id, type);
          const draft = notificationDraft(equipment.notifications?.[type], type);
          next.set(key, draft);
          originals.set(key, {...draft});
        }
      }
      this._drafts = next;
      this._originalDrafts = originals;
      const deviceDrafts = new Map();
      const originalDeviceDrafts = new Map();
      for (const category of ["smoke_alarms", "sensors", "automations"]) {
        for (const device of this._notifications[category]) {
          const key = `${category}:${itemId(category, device)}`;
          const draft = {enabled:Boolean(device.enabled)};
          deviceDrafts.set(key, draft);
          originalDeviceDrafts.set(key, {...draft});
        }
      }
      this._deviceDrafts = deviceDrafts;
      this._originalDeviceDrafts = originalDeviceDrafts;
    }

    _isDirty(key) {
      const draft = this._drafts.get(key);
      const original = this._originalDrafts.get(key);
      if (!draft || !original) return Boolean(draft);
      return ["period_mins", "limit", "enabled"]
        .some(field => draft[field] !== original[field]);
    }

    _isDeviceDirty(key) {
      return this._deviceDrafts.get(key)?.enabled
        !== this._originalDeviceDrafts.get(key)?.enabled;
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
        this._notifications = await this._hass.callWS({
          type:"wiser/notifications",
          hub:this._hub,
        });
        for (const category of CATEGORY_ORDER) {
          if (!Array.isArray(this._notifications?.[category])) this._notifications[category] = [];
        }
        const categories = localizedCategories(this._notifications, this._hass);
        if (!categories.includes(this._category)) this._category = categories[0] || "equipment";
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
      this._notifications = {equipment:[], smoke_alarms:[], sensors:[], automations:[]};
      this._drafts.clear();
      this._load();
    }

    _input(event) {
      const input = event.target?.closest?.("[data-field]");
      const deviceSection = input?.closest?.("[data-device-control]");
      if (input && deviceSection?.dataset?.category) {
        const key = `${deviceSection.dataset.category}:${deviceSection.dataset.deviceId}`;
        const draft = this._deviceDrafts.get(key);
        if (!draft) return;
        draft.enabled = input.checked;
        const save = deviceSection.querySelector?.('[data-action="save-device"]');
        const unchanged = !this._isDeviceDirty(key);
        save?.toggleAttribute?.("hidden", unchanged);
        save?.toggleAttribute?.("disabled", unchanged);
        return;
      }
      const section = input?.closest?.("[data-notification]");
      if (!input || !section) return;
      const key = this._key(Number(section.dataset.equipmentId), section.dataset.notification);
      const draft = this._drafts.get(key);
      if (!draft) return;
      if (input.dataset.field === "enabled") draft.enabled = input.checked;
      else draft[input.dataset.field] = Number(input.value);
      const save = section.querySelector?.('[data-action="save"]');
      const unchanged = draft.configured && !this._isDirty(key);
      save?.toggleAttribute?.("hidden", unchanged);
      save?.toggleAttribute?.("disabled", unchanged);
      const remove = section.querySelector?.('[data-action="delete"]');
      remove?.toggleAttribute?.("hidden", draft.configured && !unchanged);
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
      const draft = this._drafts.get(key);
      if (!draft || (draft.configured && !this._isDirty(key))) return;
      const inputs = [...section.querySelectorAll("input[data-field]")];
      if (!inputs.every(input => input.reportValidity())) return;
      if (!Number.isInteger(draft.period_mins) || !Number.isInteger(draft.limit)) return;
      this._busy.add(key);
      this._error = "";
      this._renderSoon();
      try {
        this._notifications.equipment = await this._hass.callWS({
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
        this._notifications.equipment = await this._hass.callWS({
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

    async _saveDevice(section) {
      if (!this._hass?.user?.is_admin) return;
      const category = section.dataset.category;
      const deviceId = Number(section.dataset.deviceId);
      const key = `${category}:${deviceId}`;
      const draft = this._deviceDrafts.get(key);
      if (!draft || !this._isDeviceDirty(key)) return;
      this._busy.add(key);
      this._error = "";
      this._renderSoon();
      try {
        const message = category === "automations"
          ? {
              type:"wiser/automation/set_enabled",
              hub:this._hub,
              automation_id:deviceId,
              enabled:draft.enabled,
            }
          : {
              type:"wiser/device_notification/set",
              hub:this._hub,
              category:category === "smoke_alarms" ? "smoke_alarm" : "sensor",
              device_id:deviceId,
              enabled:draft.enabled,
            };
        this._notifications = await this._hass.callWS(message);
        this._seedDrafts();
        this._notify(this._t("panel.saved"));
      } catch (error) {
        this._error = this._t("panel.save_error", {error:error?.message || error});
      } finally {
        this._busy.delete(key);
        this._renderSoon();
      }
    }

    _hubSettings(hub = this._hub) {
      return this._config?.card_configs?.[hub] || {};
    }

    _categoryItems(category) {
      const items = category === "equipment"
        ? compatibleEquipment(this._notifications.equipment)
        : this._notifications[category] || [];
      return orderedItems(category, items, this._hubSettings()?.item_order?.[category]);
    }

    _itemName(category, item) {
      if (item.name) return item.name;
      if (category === "equipment") return `${item.device_type || "Equipment"} ${item.equipment_id}`;
      if (category === "automations") return `Automation ${item.automation_id}`;
      return `${item.device_type || item.sensor_type || "Device"} ${item.device_id}`;
    }

    _openSettings() {
      if (!this._hass?.user?.is_admin || !this._config?.panel_id || !this._hub) return;
      const settings = this._hubSettings();
      const itemOrder = {...(settings.item_order || {})};
      for (const category of localizedCategories(this._notifications, this._hass)) {
        itemOrder[category] = this._categoryItems(category)
          .map(item => itemId(category, item));
      }
      this._settingsDraft = {
        columns:deviceColumns(settings.columns),
        item_order:itemOrder,
      };
      this._settingsCategory = localizedCategories(this._notifications, this._hass)
        .includes(this._category)
        ? this._category
        : localizedCategories(this._notifications, this._hass)[0] || "";
      this._settingsError = "";
      this._settingsOpen = true;
      this._renderSoon();
    }

    _openEditor() {
      this._openSettings();
    }

    _closeSettings() {
      this._settingsOpen = false;
      this._settingsDraft = null;
      this._settingsCategory = "";
      this._settingsError = "";
      this._draggedItem = null;
      this._renderSoon();
    }

    async _saveSettings() {
      if (!this._settingsDraft || this._savingSettings || !this._config?.panel_id) return;
      this._savingSettings = true;
      this._settingsError = "";
      this._renderSettingsState();
      try {
        const settings = {...this._hubSettings()};
        settings.columns = deviceColumns(this._settingsDraft.columns);
        settings.item_order = Object.fromEntries(Object.entries(this._settingsDraft.item_order)
          .map(([category, order]) => [category, [...new Set(order.map(String))]]));
        await this._hass.callWS({
          type:"wiser/panel/configure",
          panel_id:this._config.panel_id,
          configs:{[this._hub]:settings},
        });
        this._config = {
          ...this._config,
          card_configs:{...this._config.card_configs, [this._hub]:settings},
        };
        this._closeSettings();
      } catch (error) {
        this._settingsError = this._t("panel.settings_save_error", {error:error?.message || error});
        this._renderSettingsState();
      } finally {
        this._savingSettings = false;
        this._renderSettingsState();
      }
    }

    _settingsDragStart(event) {
      const handle = event.target?.closest?.(".order-drag-handle");
      const row = handle?.closest?.(".order-item");
      if (!row || !this._settingsDraft) return;
      this._draggedItem = {category:row.dataset.category, id:row.dataset.itemId};
      row.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.dataset.itemId);
      }
    }

    _settingsDropPosition(event) {
      if (!this._draggedItem) return null;
      const row = event.target?.closest?.(".order-item");
      const list = row?.parentElement || event.target?.closest?.(".order-list");
      if (!list || list.dataset.category !== this._draggedItem.category) return null;
      if (!row || row.dataset.itemId === this._draggedItem.id) return {list, row:null, after:false};
      const rect = row.getBoundingClientRect();
      return {list, row, after:event.clientY >= rect.top + rect.height / 2};
    }

    _settingsDragOver(event) {
      const position = this._settingsDropPosition(event);
      if (!position) return;
      event.preventDefault();
      for (const row of position.list.querySelectorAll(".order-item")) {
        row.classList.remove("drop-before", "drop-after");
      }
      position.row?.classList.add(position.after ? "drop-after" : "drop-before");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }

    _settingsDrop(event) {
      const position = this._settingsDropPosition(event);
      const dragged = this._draggedItem;
      if (!position || !dragged) return;
      event.preventDefault();
      const draggedRow = Array.from(position.list.querySelectorAll(".order-item"))
        .find(row => row.dataset.itemId === dragged.id);
      if (draggedRow) {
        if (position.row) {
          position.list.insertBefore(draggedRow, position.after ? position.row.nextSibling : position.row);
        } else {
          position.list.append(draggedRow);
        }
      }
      this._settingsDraft.item_order[dragged.category] = Array.from(
        position.list.querySelectorAll(".order-item"), row => row.dataset.itemId,
      );
      this._clearSettingsDrag();
    }

    _clearSettingsDrag() {
      this._draggedItem = null;
      for (const row of this.shadowRoot.querySelectorAll?.(".order-item") || []) {
        row.classList.remove("dragging", "drop-before", "drop-after");
      }
    }

    _renderSettingsState() {
      const dialog = this.shadowRoot.querySelector?.("#settings-dialog");
      if (!dialog || !this._settingsOpen) return;
      const error = dialog.querySelector?.(".settings-error");
      if (error) error.textContent = this._settingsError;
      for (const control of dialog.querySelectorAll?.(".column-setting, [data-action='settings-cancel'], [data-action='settings-save']") || []) {
        control.disabled = this._savingSettings;
      }
    }

    _selectSettingsCategory(category) {
      const categories = localizedCategories(this._notifications, this._hass);
      if (!this._settingsOpen || !categories.includes(category)) return;
      this._settingsCategory = category;
      const dialog = this.shadowRoot.querySelector?.("#settings-dialog");
      if (!dialog) return;
      for (const tab of dialog.querySelectorAll?.(".settings-category-tab") || []) {
        tab.setAttribute("aria-selected", String(tab.dataset.category === category));
      }
      const orderSection = dialog.querySelector?.(".settings-order-section");
      if (orderSection) orderSection.innerHTML = this._settingsOrderMarkup(category);
    }

    _click(event) {
      const target = event.target?.closest?.("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action === "menu") {
        this.dispatchEvent(new CustomEvent("hass-toggle-menu", {bubbles:true, composed:true}));
      } else if (action === "refresh" || action === "retry") this._load();
      else if (action === "hub") this._selectHub(target.dataset.hub);
      else if (action === "settings-category") {
        this._selectSettingsCategory(target.dataset.category);
      }
      else if (action === "category") {
        const categories = localizedCategories(this._notifications, this._hass);
        if (categories.includes(target.dataset.category)) {
          this._category = target.dataset.category;
          this._renderSoon();
        }
      }
      else if (action === "settings") this._openSettings();
      else if (action === "settings-cancel") this._closeSettings();
      else if (action === "settings-save") this._saveSettings();
      else if (action === "save") this._save(target.closest("[data-notification]"));
      else if (action === "save-device") this._saveDevice(target.closest("[data-device-control]"));
      else if (action === "delete") this._delete(target.closest("[data-notification]"));
    }

    _notification(equipment, type, admin) {
      const key = this._key(equipment.equipment_id, type);
      const draft = this._drafts.get(key) || notificationDraft(null, type);
      const busy = this._busy.has(key);
      const controlsDisabled = !admin || busy ? " disabled" : "";
      const configured = draft.configured;
      const unchanged = configured && !this._isDirty(key);
      const saveDisabled = !admin || busy || unchanged
        ? " disabled"
        : "";
      const saveHidden = unchanged ? " hidden" : "";
      const deleteHidden = configured && !unchanged ? " hidden" : "";
      return `<section class="notification" data-notification="${type}" data-equipment-id="${equipment.equipment_id}">
        <div class="notification-heading">
          <div class="notification-icon ${type}"><ha-icon icon="${type === "under" ? "mdi:trending-down" : "mdi:trending-up"}"></ha-icon></div>
          <div><h3>${esc(this._t(`notification.${type}`))}</h3>
            <p>${esc(this._t(`notification.${type}_description`))}</p></div>
          <span class="status ${configured ? "configured" : ""}">${esc(this._t(configured ? "notification.configured" : "notification.not_configured"))}</span>
        </div>
        <div class="fields">
          <label><span>${esc(this._t("notification.limit"))}</span>
            <span class="number-field"><input data-field="limit" type="number" min="0" step="1" required value="${draft.limit}"${controlsDisabled}>
              <span>${esc(this._t("notification.watts"))}</span></span></label>
          <label><span>${esc(this._t("notification.period"))}</span>
            <span class="number-field"><input data-field="period_mins" type="number" min="0" step="1" required value="${draft.period_mins}"${controlsDisabled}>
              <span>${esc(this._t("notification.minutes"))}</span></span></label>
        </div>
        <div class="notification-footer">
          <label class="enabled"><input data-field="enabled" type="checkbox"${draft.enabled ? " checked" : ""}${controlsDisabled}>
            <span>${esc(this._t("notification.enabled"))}</span></label>
          ${admin ? `<div class="actions">
            ${configured ? `<ha-button appearance="outlined" variant="danger" data-action="delete"${deleteHidden}${controlsDisabled}>${esc(this._t("action.delete"))}</ha-button>` : ""}
            <ha-button data-action="save"${saveHidden}${saveDisabled}>${busy ? `<ha-circular-progress active size="small"></ha-circular-progress>` : esc(this._t(configured ? "action.save" : "action.create"))}</ha-button>
          </div>` : ""}
        </div>
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

    _deviceCard(device, category, admin) {
      const deviceId = itemId(category, device);
      const sourceEnabled = device.enabled;
      const key = `${category}:${deviceId}`;
      const draft = this._deviceDrafts.get(key) || {enabled:Boolean(sourceEnabled)};
      const busy = this._busy.has(key);
      const unchanged = !this._isDeviceDirty(key);
      const icon = category === "smoke_alarms"
        ? "mdi:smoke-detector"
        : category === "automations" ? "mdi:robot" : "mdi:door";
      const detail = category === "smoke_alarms"
        ? device.device_type
        : category === "automations"
          ? this._t("automation.description")
          : [device.sensor_type, device.device_type].filter(Boolean).join(" · ");
      const fallbackName = category === "automations"
        ? `Automation ${deviceId}`
        : `${detail} ${deviceId}`;
      return `<article class="device-card" data-device-control data-category="${category}" data-device-id="${deviceId}">
        <div class="device-heading">
          <div class="equipment-icon"><ha-icon icon="${icon}"></ha-icon></div>
          <div><h2>${esc(device.name || fallbackName)}</h2>
            <p>${esc(detail)}</p></div>
          <span class="status configured">${esc(this._t(draft.enabled ? "notification.enabled" : "notification.disabled"))}</span>
        </div>
        <div class="device-controls">
          <div><h3>${esc(this._t("notification.enabled"))}</h3>
            <p>${esc(this._t(category === "automations" ? "automation.description" : "device.notification_description"))}</p></div>
          <label class="enabled device-toggle"><input data-field="enabled" type="checkbox"${draft.enabled ? " checked" : ""}${!admin || busy ? " disabled" : ""}>
            <span>${esc(this._t("notification.enabled"))}</span></label>
          ${admin ? `<ha-button data-action="save-device"${unchanged ? " hidden disabled" : ""}${busy ? " disabled" : ""}>${busy ? `<ha-circular-progress active size="small"></ha-circular-progress>` : esc(this._t("action.save"))}</ha-button>` : ""}
        </div>
      </article>`;
    }

    _automationCard(automation) {
      return `<article class="device-card">
        <div class="device-heading">
          <div class="equipment-icon"><ha-icon icon="mdi:robot"></ha-icon></div>
          <div><h2>${esc(automation.name || `Automation ${automation.automation_id}`)}</h2>
            <p>${esc(this._t("automation.description"))}</p></div>
          <span class="status ${automation.enabled ? "configured" : ""}">${esc(this._t(automation.enabled ? "notification.enabled" : "notification.disabled"))}</span>
        </div>
        <p class="app-managed">${esc(this._t("automation.unavailable"))}</p>
      </article>`;
    }

    _categoryContent(category, admin) {
      if (category === "equipment") {
        return this._categoryItems(category)
          .map(item => this._equipmentCard(item, admin)).join("");
      }
      if (category === "automations") {
        return this._categoryItems(category)
          .map(item => item.writable
            ? this._deviceCard(item, category, admin)
            : this._automationCard(item))
          .join("");
      }
      return this._categoryItems(category)
        .map(item => this._deviceCard(item, category, admin)).join("");
    }

    _settingsOrderMarkup(category) {
      if (!this._settingsDraft) return "";
      const items = category === "equipment"
        ? compatibleEquipment(this._notifications.equipment)
        : this._notifications[category] || [];
      const ordered = orderedItems(
        category,
        items,
        this._settingsDraft.item_order[category],
      );
      const rows = ordered.map(item => `<div class="order-item" data-category="${esc(category)}" data-item-id="${esc(itemId(category, item))}">
        <ha-icon class="order-drag-handle" icon="mdi:drag-vertical" draggable="true"></ha-icon>
        <span>${esc(this._itemName(category, item))}</span>
      </div>`).join("");
      return `<section class="order-section">
        <h3>${esc(this._t(`category.${category}`))}</h3>
        <div class="order-list" data-category="${esc(category)}">${rows}</div>
      </section>`;
    }

    _settingsMarkup() {
      if (!this._settingsDraft) return "";
      const categories = localizedCategories(this._notifications, this._hass);
      const selectedCategory = categories.includes(this._settingsCategory)
        ? this._settingsCategory
        : categories[0];
      const categoryTabs = categories.length ? `<nav class="settings-category-tabs" role="tablist">
        ${categories.map(category => `<button type="button" class="settings-category-tab" data-action="settings-category" data-category="${esc(category)}" role="tab" aria-selected="${category === selectedCategory}">${esc(this._t(`category.${category}`))}</button>`).join("")}
      </nav>` : "";
      const orderSection = selectedCategory
        ? this._settingsOrderMarkup(selectedCategory)
        : "";
      return `<div class="settings-content">
          <p>${esc(this._t("panel.settings_description"))}</p>
          <ha-form class="column-setting"></ha-form>
          <section class="order-settings">
            <h2>${esc(this._t("panel.device_order"))}</h2>
            <p>${esc(this._t("panel.order_hint"))}</p>
            ${categoryTabs}
            <div class="settings-order-section">${orderSection}</div>
          </section>
          <div class="settings-version">Wiser Notifications Panel · ${esc(VERSION)}</div>
          <p class="settings-error" role="alert">${esc(this._settingsError)}</p>
        </div>
        <div class="settings-actions" id="settings-actions" slot="footer">
          <ha-button appearance="plain" data-action="settings-cancel"${this._savingSettings ? " disabled" : ""}>${esc(this._t("action.cancel"))}</ha-button>
          <ha-button data-action="settings-save"${this._savingSettings ? " disabled" : ""}>${esc(this._t("action.save"))}</ha-button>
        </div>`;
    }

    _style() {
      return `<style>
        :host { display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden; color:var(--primary-text-color); background:var(--primary-background-color); font-family:var(--ha-font-family-body, sans-serif); }
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
        :host([nested]) .header-settings { display:none; }
        :host([nested]) .app-header.single-hub { display:none; }
        main { flex:1 1 auto; width:100%; min-height:0; margin:0; padding:24px clamp(12px, 3vw, 32px) 40px; overflow-y:auto; overscroll-behavior:contain; }
        .hero { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:24px; }
        .hero h2 { margin:0 0 6px; font-size:28px; line-height:1.2; }
        .hero p { margin:0; color:var(--secondary-text-color); }
        .category-tabs { display:flex; gap:4px; overflow:auto; margin:-4px 0 22px; border-bottom:1px solid var(--divider-color); }
        .category-tab { min-height:48px; padding:0 18px; border:0; border-bottom:3px solid transparent; color:var(--secondary-text-color); background:transparent; font:inherit; cursor:pointer; white-space:nowrap; }
        .category-tab[aria-selected="true"] { color:var(--primary-color); border-bottom-color:var(--primary-color); }
        .refresh { display:flex; align-items:center; gap:8px; }
        .message { padding:22px; border-radius:16px; background:var(--ha-card-background, var(--card-background-color)); box-shadow:var(--ha-card-box-shadow); }
        .message.error { color:var(--error-color, #db4437); border-inline-start:4px solid currentColor; }
        .read-only { margin:0 0 16px; padding:12px 16px; border-radius:12px; color:var(--warning-color, #f0a000); background:color-mix(in srgb, currentColor 10%, transparent); }
        .equipment-list { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); align-items:start; gap:16px; }
        .equipment-list.columns-1 { grid-template-columns:minmax(0, 1fr); }
        .equipment-list.columns-3 { grid-template-columns:repeat(3, minmax(0, 1fr)); }
        .equipment-list.columns-4 { grid-template-columns:repeat(4, minmax(0, 1fr)); }
        .equipment-card, .device-card { container-type:inline-size; overflow:hidden; border-radius:16px; background:var(--ha-card-background, var(--card-background-color)); box-shadow:var(--ha-card-box-shadow); }
        .equipment-heading { display:flex; align-items:center; gap:12px; padding:15px 17px; border-bottom:1px solid var(--divider-color); }
        .equipment-heading h2 { margin:0; font-size:18px; }
        .equipment-heading p { margin:4px 0 0; color:var(--secondary-text-color); font-size:13px; }
        .device-heading { display:flex; align-items:center; gap:12px; padding:15px 17px; }
        .device-heading h2 { margin:0; font-size:18px; }
        .device-heading p { margin:4px 0 0; color:var(--secondary-text-color); font-size:13px; }
        .device-heading .status { margin-inline-start:auto; }
        .device-controls { display:grid; grid-template-columns:minmax(0, 1fr) auto auto; align-items:center; gap:14px; padding:14px 17px; border-top:1px solid var(--divider-color); }
        .device-controls h3 { margin:0 0 4px; font-size:16px; }
        .device-controls p, .app-managed { margin:0; color:var(--secondary-text-color); font-size:13px; }
        .device-toggle { grid-column:auto; white-space:nowrap; }
        .device-controls [hidden] { display:none !important; }
        .app-managed { padding:0 17px 15px; }
        .equipment-icon, .notification-icon { display:grid; place-items:center; flex:0 0 auto; border-radius:14px; color:var(--primary-color); background:color-mix(in srgb, var(--primary-color) 12%, transparent); }
        .equipment-icon { width:40px; height:40px; }
        .notification-icon { width:36px; height:36px; }
        .notification-icon.under { color:var(--info-color, #039be5); background:color-mix(in srgb, currentColor 12%, transparent); }
        .notification-icon.over { color:var(--warning-color, #f0a000); background:color-mix(in srgb, currentColor 12%, transparent); }
        .monitoring { margin-inline-start:auto; padding:5px 9px; border-radius:999px; color:var(--secondary-text-color); background:var(--secondary-background-color); font-size:12px; }
        .notification-grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); }
        .notification { min-width:0; padding:16px 17px; }
        .notification + .notification { border-inline-start:1px solid var(--divider-color); }
        .notification-heading { display:grid; grid-template-columns:auto minmax(0, 1fr); align-items:start; gap:10px; min-height:78px; }
        .notification-heading h3 { margin:0 0 4px; font-size:16px; }
        .notification-heading p { margin:0; color:var(--secondary-text-color); font-size:13px; line-height:1.45; }
        .status { grid-column:2; justify-self:start; padding:4px 8px; border-radius:999px; color:var(--secondary-text-color); background:var(--secondary-background-color); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
        .status.configured { color:var(--success-color, #43a047); background:color-mix(in srgb, currentColor 12%, transparent); }
        .fields { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px; }
        .fields label { display:grid; gap:7px; color:var(--secondary-text-color); font-size:13px; }
        .number-field { display:flex; align-items:center; overflow:hidden; min-height:40px; border:1px solid var(--divider-color); border-radius:10px; background:var(--primary-background-color); }
        .number-field:focus-within { border-color:var(--primary-color); box-shadow:0 0 0 1px var(--primary-color); }
        .number-field input { width:100%; min-width:0; padding:8px 10px; border:0; outline:0; color:var(--primary-text-color); background:transparent; font:inherit; font-size:15px; }
        .number-field > span { padding:0 10px; color:var(--secondary-text-color); white-space:nowrap; }
        .enabled { grid-column:1 / -1; display:flex !important; align-items:center; gap:9px !important; min-height:34px; color:var(--primary-text-color) !important; }
        .enabled input { width:19px; height:19px; margin:0; accent-color:var(--primary-color); }
        input:disabled { opacity:.6; }
        .notification-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 16px; min-height:40px; margin-top:10px; }
        .notification-footer .enabled { grid-column:auto; }
        .actions { display:flex; justify-content:flex-end; gap:8px; min-height:40px; }
        .actions [hidden] { display:none !important; }
        .actions ha-circular-progress { --mdc-theme-primary:currentColor; }
        .settings-content { width:100%; max-width:600px; padding:4px 2px 16px; }
        .settings-content > p { margin:0 0 18px; color:var(--secondary-text-color); }
        .column-setting { display:block; width:100%; margin:8px 0 18px; }
        .order-settings { border-top:1px solid var(--divider-color); padding-top:18px; }
        .order-settings > h2 { margin:0 0 4px; font-size:18px; }
        .order-settings > p { margin:0 0 16px; color:var(--secondary-text-color); font-size:13px; }
        .settings-category-tabs { display:flex; min-width:0; overflow-x:auto; margin:0 0 16px; border-bottom:1px solid var(--divider-color); }
        .settings-category-tab { flex:0 0 auto; min-height:42px; padding:0 16px; border:0; border-bottom:3px solid transparent; color:var(--secondary-text-color); background:transparent; font:inherit; cursor:pointer; white-space:nowrap; }
        .settings-category-tab[aria-selected="true"] { color:var(--primary-color); border-bottom-color:var(--primary-color); }
        .order-section + .order-section { margin-top:18px; }
        .order-section h3 { margin:0 0 8px; font-size:15px; }
        .order-list { display:grid; gap:6px; }
        .order-item { position:relative; display:grid; grid-template-columns:32px minmax(0, 1fr); align-items:center; min-height:44px; padding:6px 12px 6px 6px; border:1px solid var(--divider-color); border-radius:10px; background:var(--ha-card-background, var(--card-background-color)); }
        .order-drag-handle { cursor:grab; color:var(--secondary-text-color); }
        .order-drag-handle:active { cursor:grabbing; }
        .order-item.dragging { opacity:.45; }
        .order-item.drop-before::before, .order-item.drop-after::after { content:""; position:absolute; right:0; left:0; height:3px; border-radius:2px; background:var(--primary-color); }
        .order-item.drop-before::before { top:-5px; }
        .order-item.drop-after::after { bottom:-5px; }
        .settings-version { margin-top:24px; color:var(--secondary-text-color); font-size:12px; text-align:right; }
        .settings-error { min-height:20px; margin:14px 0 0 !important; color:var(--error-color, #db4437) !important; }
        .settings-actions { display:flex; justify-content:flex-end; gap:8px; }
        @container (max-width:680px) {
          .fields { grid-template-columns:1fr; }
          .notification-heading { min-height:124px; }
          .notification-footer { align-items:flex-end; }
        }
        @container (max-width:560px) {
          .equipment-heading, .device-heading { gap:9px; padding:11px 12px; }
          .equipment-heading h2, .device-heading h2 { font-size:16px; }
          .equipment-heading p, .device-heading p { margin-top:2px; font-size:11px; }
          .equipment-icon { width:34px; height:34px; border-radius:11px; }
          .monitoring { padding:3px 6px; font-size:10px; }
          .notification { padding:11px 12px; }
          .notification-icon { width:30px; height:30px; border-radius:10px; }
          .notification-heading { gap:7px; min-height:104px; }
          .notification-heading h3 { margin-bottom:3px; font-size:14px; }
          .notification-heading p { font-size:11px; line-height:1.35; }
          .status { padding:3px 6px; font-size:9px; }
          .fields { gap:7px; margin-top:8px; }
          .fields label { gap:4px; font-size:11px; }
          .number-field { min-height:35px; border-radius:8px; }
          .number-field input { padding:6px 8px; font-size:14px; }
          .number-field > span { padding:0 7px; font-size:11px; }
          .notification-footer { min-height:36px; margin-top:7px; }
          .enabled { gap:6px !important; min-height:30px; font-size:12px; }
          .enabled input { width:17px; height:17px; }
          .actions { min-height:36px; }
          .device-controls { gap:9px; padding:11px 12px; }
          .device-controls h3 { font-size:14px; }
          .device-controls p, .app-managed { font-size:11px; }
          .app-managed { padding:0 12px 12px; }
        }
        @media (max-width:800px) {
          .app-header { padding:0 8px; gap:4px; }
          .app-header h1 { font-size:16px; }
          .hub-tabs { margin-inline-start:0; }
          .hub-tab { padding:0 12px; }
          main { padding-top:20px; }
          .hero h2 { font-size:24px; }
          .device-controls { grid-template-columns:1fr auto; }
          .device-controls > div { grid-column:1 / -1; }
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
      const canConfigure = admin && Boolean(this._config?.panel_id);
      const tabs = hubs.length > 1 ? `<nav class="hub-tabs" role="tablist" aria-label="${esc(this._t("panel.hubs"))}">
        ${hubs.map(hub => `<button class="hub-tab" data-action="hub" data-hub="${esc(hub)}" role="tab" aria-selected="${hub === this._hub}">${esc(hub)}</button>`).join("")}
      </nav>` : `<div class="hub-tabs"></div>`;
      const headerClass = `app-header${hubs.length <= 1 ? " single-hub" : ""}${canConfigure ? " has-settings" : ""}`;
      const automationCategory = this._category === "automations";
      const pageTitle = this._t(automationCategory ? "panel.automations_title" : "panel.title");
      const pageSubtitle = this._t(automationCategory ? "panel.automations_subtitle" : "panel.subtitle");
      let content;
      if (this._loading) content = `<p class="message" role="status">${esc(this._t("panel.loading"))}</p>`;
      else if (this._error) content = `<div class="message error" role="alert">${esc(this._error)}<br><ha-button data-action="retry">${esc(this._t("panel.retry"))}</ha-button></div>`;
      else {
        const categories = localizedCategories(this._notifications, this._hass);
        const categoryTabs = categories.length ? `<nav class="category-tabs" role="tablist">
          ${categories.map(category => `<button class="category-tab" data-action="category" data-category="${category}" role="tab" aria-selected="${category === this._category}">${esc(this._t(`category.${category}`))}</button>`).join("")}
        </nav>` : "";
        const categoryContent = this._categoryContent(this._category, admin);
        const columns = deviceColumns(this._hubSettings().columns);
        content = `${admin ? "" : `<p class="read-only">${esc(this._t("panel.read_only"))}</p>`}
          ${categoryTabs}
          ${categoryContent ? `<div class="equipment-list category-${esc(this._category)} columns-${columns}">${categoryContent}</div>` : `<p class="message">${esc(this._t("panel.empty"))}</p>`}`;
      }
      this.shadowRoot.innerHTML = `${this._style()}
        <header class="${headerClass}">
          <button class="icon-button menu-button" data-action="menu" aria-label="${esc(this._t("panel.menu"))}"><ha-icon icon="mdi:menu"></ha-icon></button>
          <h1>${esc(pageTitle)}</h1>${tabs}
          ${canConfigure ? `<ha-button class="header-settings" appearance="plain" data-action="settings" aria-label="${esc(this._t("panel.settings"))}" title="${esc(this._t("panel.settings"))}"><ha-icon icon="mdi:cog"></ha-icon></ha-button>` : ""}
        </header>
        <main>
          <div class="hero"><div><h2>${esc(pageTitle)}</h2><p>${esc(pageSubtitle)}</p></div>
            <ha-button class="refresh" appearance="plain" data-action="refresh"><ha-icon icon="mdi:refresh"></ha-icon><span>${esc(this._t("panel.refresh"))}</span></ha-button></div>
          <div aria-live="polite">${content}</div>
        </main>
        <ha-dialog id="settings-dialog" width="medium">${this._settingsOpen ? this._settingsMarkup() : ""}</ha-dialog>`;
      if (this._settingsOpen) {
        const dialog = this.shadowRoot.querySelector?.("#settings-dialog");
        if (dialog) {
          const heading = `${this._hub} - ${this._t("panel.settings")}`;
          dialog.setAttribute?.("aria-label", heading);
          dialog.setAttribute?.("header-title", heading);
          dialog.heading = heading;
          if (!("headerTitle" in (customElements.get("ha-dialog")?.prototype || {}))) {
            dialog.querySelector?.("#settings-actions")?.removeAttribute("slot");
          }
          dialog.addEventListener?.("closed", () => this._closeSettings(), {once:true});
          dialog.addEventListener?.("close-dialog", () => this._closeSettings(), {once:true});
          const columnForm = dialog.querySelector?.(".column-setting");
          if (columnForm) {
            columnForm.hass = this._hass;
            columnForm.computeLabel = schema => schema.label;
            columnForm.schema = [{
              name:"columns",
              label:`${this._t("panel.devices_per_row")} — desktop`,
              selector:{number:{min:1, max:4, step:1, mode:"box"}},
            }];
            columnForm.data = {columns:this._settingsDraft.columns};
            columnForm.addEventListener?.("value-changed", event => {
              event.stopPropagation();
              this._settingsDraft.columns = deviceColumns(event.detail?.value?.columns);
              columnForm.data = {columns:this._settingsDraft.columns};
            });
          }
          dialog.open = true;
        }
      }
    }
  }

  window.WiserNotificationsPanelTest = {
    compatibleEquipment,
    availableCategories,
    localizedCategories,
    deviceColumns,
    itemId,
    languageFor,
    localize,
    notificationDraft,
    orderedItems,
  };
  if (!customElements.get("wiser-notifications-panel")) {
    customElements.define("wiser-notifications-panel", WiserNotificationsPanel);
  }
  console.info(`%c WISER-NOTIFICATIONS-PANEL %c ${VERSION} `, "color:#fff;background:#43a047;font-weight:700", "color:#43a047;background:#fff");
})();
