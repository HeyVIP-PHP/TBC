(async function () {
  if (window.initThemeToggle) window.initThemeToggle();
  if (window.initClock) window.initClock();
  if (window.AgentAuth) window.AgentAuth.renderWhoami("agentWhoami");
  const params = new URLSearchParams(location.search);
  const moduleId = params.get("module");
  const module = window.MODULES.find((m) => m.id === moduleId);

  const formCard = document.querySelector(".form-card");
  const titleEl = document.getElementById("formTitle");
  const iconEl = document.getElementById("formIcon");
  const hintEl = document.getElementById("formHint");

  if (!module) {
    titleEl.textContent = "Form not found";
    hintEl.textContent = "That module doesn't exist. Go back and pick one from the list.";
    formCard.querySelector("form").style.display = "none";
    return;
  }

  // Topic Access — catches someone typing/bookmarking a form.html?module=...
  // URL directly for a topic their account isn't allowed to use, since the
  // Home page sidebar hiding it (see index.html) only stops the NORMAL
  // click path, not a direct URL visit. This is still just the frontend
  // half of the check — the real enforcement is server-side in
  // functions/api/submit.js, which rejects the actual submission
  // regardless of what this page does; this is purely so a blocked agent
  // gets a clear message immediately instead of filling out a form only
  // to have Submit fail at the very end.
  if (window.AgentAuth && window.AgentAuth.filterAllowedModules([module]).length === 0) {
    titleEl.textContent = "Not available";
    hintEl.textContent = "Your account doesn't have access to this topic. Contact a SuperAdmin if you think this is wrong.";
    formCard.querySelector("form").style.display = "none";
    return;
  }

  // Settings (Maintenance / Coming soon) — a separate axis from
  // allowedModules above. Checked here so a bookmarked/typed form.html
  // URL to a toggled-off topic still gets stopped, not just the Home
  // page hiding the click path — submit.js re-checks this again
  // server-side regardless, this is purely the friendly early message.
  try {
    const statusRes = await window.AgentAuth.authFetch("/api/feature-status");
    const statusData = await statusRes.json();
    const itemStatus = statusData.ok ? statusData.items[module.id] : null;
    if (itemStatus && itemStatus.blocked) {
      titleEl.textContent = itemStatus.status === "coming_soon" ? "Coming soon" : "Under maintenance";
      hintEl.textContent = itemStatus.status === "coming_soon"
        ? "🔜 Not available yet, please check back later."
        : "⚠️ Under maintenance, please try again later.";
      formCard.querySelector("form").style.display = "none";
      return;
    }
  } catch {
    // Status check failing shouldn't block a topic that's actually fine
    // — submit.js is the real enforcement point either way.
  }

  document.title = `${module.name} — Issue Submission`;
  iconEl.textContent = module.icon;
  titleEl.textContent = module.formTitle || `${module.name} Request`;
  hintEl.textContent = module.description;
  document.getElementById("submitLabel").textContent = `Submit ${module.name}`;
  document.getElementById("reporterLabelText").textContent = module.reporterLabel || "Agent Name";

  // ---- Brand dropdown ----
  // Only the brands this logged-in agent is actually allowed to see —
  // an agent scoped to one brand shouldn't even see other brands' names
  // in the picker, not just get blocked after choosing one.
  const brandSelect = document.querySelector('select[name="brand"]');
  const visibleBrands = window.AgentAuth ? window.AgentAuth.filterAllowedBrands(window.BRANDS) : window.BRANDS;
  brandSelect.innerHTML =
    `<option value="" disabled selected>Select brand</option>` +
    visibleBrands.map((b) => `<option value="${b.id}">${b.name}</option>`).join("");

  // ---- Dynamic fields (with emphasize box + showIf conditionals) ----
  const container = document.getElementById("dynamicFields");
  const fieldEls = {}; // key -> { wrap, control }

  // The one `emphasize: true` field per module (Issue Type / Motive /
  // Promotion / Shift) acts as a "gate": every other field below it, PLUS
  // the attachments dropzone and the reporter-name field further down the
  // page, stay hidden until the gate has a value — not just fields with
  // their own explicit showIf. Keeps a half-picked form from dumping every
  // field on screen before the agent has even said what they're reporting.
  const gateField = module.fields.find((f) => f.emphasize);

  module.fields.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "field" + (f.emphasize ? " field-emphasize" : "");
    const isGated = !!(f.showIf || (gateField && f.key !== gateField.key));
    if (isGated) wrap.setAttribute("data-conditional", "true");

    const req = f.required ? '<span class="required">*</span>' : "";
    let control = "";

    if (f.type === "textarea") {
      control = `<textarea name="${f.key}" placeholder="${f.placeholder || ""}" autocomplete="off"></textarea>`;
    } else if (f.type === "select") {
      const opts = f.optionsByBrand ? [] : f.options; // optionsByBrand fields start empty, filled in by refreshBrandDependentOptions()
      control = `<select name="${f.key}">
        <option value="" disabled selected>Select ${f.label.toLowerCase()}</option>
        ${(opts || []).map((o) => `<option value="${typeof o === "string" ? o : o.value}">${typeof o === "string" ? o : o.value}</option>`).join("")}
      </select>`;
    } else if (f.generate) {
      control = `<div class="field-with-btn">
        <input type="${f.type}" name="${f.key}" placeholder="${f.placeholder || ""}" autocomplete="off" />
        <button type="button" class="btn-generate" title="Generate next ${f.label}">🔄</button>
      </div>
      <p class="field-note" id="note-${f.key}"></p>`;
    } else {
      control = `<input type="${f.type}" name="${f.key}" placeholder="${f.placeholder || ""}" autocomplete="off" />`;
    }

    wrap.innerHTML = `<label>${f.label} ${req}</label>${control}`;
    container.appendChild(wrap);
    fieldEls[f.key] = { wrap, control: wrap.querySelector("input,select,textarea"), def: f };

    if (f.defaultToday && f.type === "date") {
      // Local calendar date, not toISOString() (which is always UTC and
      // can land on the wrong day near midnight for agents in Manila,
      // UTC+8).
      const now = new Date();
      const localISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      fieldEls[f.key].control.value = localISO;
    }

    // Base required state (conditional/gated fields only become required once visible+required)
    if (f.required && !isGated) fieldEls[f.key].control.required = true;
  });

  // ---- Withdraw Issue: duplicate-TID guard ----
  // Checks the brand's "Withdraw Issue" Sheet (not KV, which gets purged
  // over time) for a TID that was already submitted. Runs onBlur (early
  // warning) and again right before submit (final guard, in case the
  // field was edited back to a flagged value without a fresh blur).
  let tidDuplicateInfo = null; // { date, pic } when the current TID value is a duplicate, else null
  let checkTidNow = null;      // only set for withdraw_issue; submit handler reads this
  let tidCheckSeq = 0;         // guards against a stale response overwriting a newer one

  if (module.id === "withdraw_issue" && fieldEls.tid) {
    const tidLabel = fieldEls.tid.wrap.querySelector("label");
    const tidWarning = document.createElement("span");
    tidWarning.className = "tid-warning";
    tidLabel.appendChild(tidWarning);
    const submitBtnEl = document.getElementById("submitBtn");

    // One function owns all three states together (warning text / red
    // input border / submit button disabled) so they can never drift
    // out of sync with each other.
    function setTidState(state, text) {
      tidWarning.textContent = text || "";
      tidWarning.className = "tid-warning" + (state ? ` ${state}` : "");
      fieldEls.tid.control.classList.toggle("field-error", state === "found");
      if (state === "found") {
        submitBtnEl.disabled = true;
        submitBtnEl.title = "This TID was already submitted — change it before continuing.";
      } else if (submitBtnEl.title) {
        submitBtnEl.disabled = false;
        submitBtnEl.title = "";
      }
    }

    async function checkTid(showChecking) {
      const brandValue = brandSelect.value;
      const tidValue = fieldEls.tid.control.value.trim();
      tidDuplicateInfo = null;
      if (!brandValue || !tidValue) { setTidState(null, ""); return null; }

      const seq = ++tidCheckSeq;
      if (showChecking) setTidState("checking", "checking…");

      let data;
      try {
        const res = await window.AgentAuth.authFetch(`/api/check-tid?brand=${encodeURIComponent(brandValue)}&tid=${encodeURIComponent(tidValue)}`);
        data = await res.json();
      } catch {
        data = { ok: false };
      }

      if (seq !== tidCheckSeq) return null; // a newer check already superseded this one
      if (!data.ok) { setTidState(null, ""); return null; }

      if (data.found) {
        tidDuplicateInfo = { date: data.date, pic: data.pic };
        const parts = [data.date, data.pic].filter(Boolean).join(" by ");
        setTidState("found", `⚠️ TID has been submitted on${parts ? ` ${parts}` : " before"}.`);
      } else {
        setTidState(null, "");
      }
      return tidDuplicateInfo;
    }

    checkTidNow = checkTid;
    fieldEls.tid.control.addEventListener("blur", () => checkTid(true));
    // Retyping clears the warning immediately — no need to wait for another blur.
    fieldEls.tid.control.addEventListener("input", () => { if (tidDuplicateInfo) setTidState(null, ""); });
    // Switching brands invalidates any prior result (it was checked against the old brand's sheet).
    brandSelect.addEventListener("change", () => setTidState(null, ""));
  }

  // ---- Brand-dependent select options (e.g. Promotion / Tier Level lists
  // that differ per brand) — rebuilt whenever the brand changes. ----
  function refreshBrandDependentOptions() {
    const brandValue = brandSelect.value;
    module.fields.forEach((f) => {
      if (!f.optionsByBrand) return;
      const { control } = fieldEls[f.key];
      const currentValue = control.value;
      const opts = f.optionsByBrand[brandValue] || [];
      control.innerHTML =
        `<option value="" disabled selected>Select ${f.label.toLowerCase()}</option>` +
        opts
          .map((o) => {
            const val = typeof o === "string" ? o : o.value;
            const amountAttr = typeof o === "object" && o.amount !== undefined ? ` data-amount="${o.amount}"` : "";
            return `<option value="${val}"${amountAttr}>${val}</option>`;
          })
          .join("");
      if (opts.some((o) => (typeof o === "string" ? o : o.value) === currentValue)) {
        control.value = currentValue;
      }
    });
  }

  // Locks the Amount field in priority order: (1) a fixed brand+promotion
  // combo with no selector needed (e.g. Betjili Birthday Bonus), then (2)
  // whichever visible field has autoFillsInto set (Tier Level / Number of
  // Deposits) and a value with a matching data-amount. Falls back to
  // unlocked + cleared if neither applies.
  function refreshAutoFilledAmounts() {
    const amountField = fieldEls.amount;
    if (!amountField) return;

    if (module.fixedAmounts) {
      const promotionValue = fieldEls.promotion ? fieldEls.promotion.control.value : "";
      const fixed = module.fixedAmounts[`${brandSelect.value}|${promotionValue}`];
      if (fixed !== undefined) {
        amountField.control.value = fixed;
        amountField.control.readOnly = true;
        return;
      }
    }

    let locked = false;
    module.fields.forEach((f) => {
      if (!f.autoFillsInto) return;
      const source = fieldEls[f.key];
      const target = fieldEls[f.autoFillsInto];
      if (!source || !target) return;
      const visible = !f.showIf || source.wrap.classList.contains("is-visible");
      const selectedOption = visible && source.control.value
        ? source.control.querySelector(`option[value="${CSS.escape(source.control.value)}"]`)
        : null;
      const amount = selectedOption && selectedOption.dataset.amount;
      if (amount) {
        target.control.value = amount;
        target.control.readOnly = true;
        locked = true;
      }
    });

    if (!locked) {
      amountField.control.readOnly = false;
      amountField.control.value = "";
    }
  }

  // Wire up conditional visibility: whenever a field that something depends
  // on changes, re-check every conditional field. `showIf` can be a single
  // { field, oneOf } or an array of them (all must match — AND logic).
  function conditionMet(showIf) {
    const conditions = Array.isArray(showIf) ? showIf : [showIf];
    return conditions.every((c) => {
      if (c.field === "brand") return c.oneOf.includes(brandSelect.value);
      const driver = fieldEls[c.field];
      return driver && c.oneOf.includes(driver.control.value);
    });
  }
  const gateHasValue = () => !gateField || !!fieldEls[gateField.key].control.value;
  const attachFieldWrap = document.getElementById("attachLabel").closest(".field");
  const reporterFieldWrap = document.querySelector('input[name="reporter"]').closest(".field");
  const reporterControl = reporterFieldWrap.querySelector("input,select,textarea");
  function refreshConditionals() {
    module.fields.forEach((f) => {
      if (!f.showIf && (!gateField || f.key === gateField.key)) return; // never gated
      const visible = f.showIf ? conditionMet(f.showIf) : gateHasValue();
      const { wrap, control } = fieldEls[f.key];
      wrap.classList.toggle("is-visible", visible);
      control.required = visible && !!f.required;
      if (!visible) control.value = "";
    });
    // Attachments + reporter name live outside module.fields (static markup
    // in form.html), gated the same way once a module actually has a gate.
    if (gateField) {
      const gated = gateHasValue();
      attachFieldWrap.classList.toggle("is-visible", gated);
      reporterFieldWrap.classList.toggle("is-visible", gated);
      reporterControl.required = gated;
    }
    refreshAutoFilledAmounts();
  }
  if (gateField) {
    attachFieldWrap.setAttribute("data-conditional", "true");
    reporterFieldWrap.setAttribute("data-conditional", "true");
  }
  module.fields.forEach((f) => {
    if (f.type === "select") fieldEls[f.key].control.addEventListener("change", refreshConditionals);
  });
  brandSelect.addEventListener("change", () => {
    refreshBrandDependentOptions();
    refreshConditionals();
  });
  refreshBrandDependentOptions();
  refreshConditionals();

  // ---- TID / sequence "generate" buttons ----
  module.fields.forEach((f) => {
    if (!f.generate) return;
    const { wrap, control } = fieldEls[f.key];
    const btn = wrap.querySelector(".btn-generate");
    const note = wrap.querySelector(`#note-${f.key}`);
    btn.addEventListener("click", async () => {
      const brandValue = brandSelect.value;
      if (!brandValue) {
        note.textContent = "Select a brand first.";
        note.className = "field-note err";
        return;
      }
      btn.disabled = true;
      note.textContent = "Generating…";
      note.className = "field-note";
      try {
        const res = await window.AgentAuth.authFetch("/api/next-tid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            module: module.id,
            brand: brandValue,
            promotion: fieldEls.promotion ? fieldEls.promotion.control.value : null,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Could not generate.");
        control.value = data.value;
        note.textContent = data.message || "Generated.";
        note.className = "field-note ok";
      } catch (err) {
        note.textContent = err.message || "Failed to generate.";
        note.className = "field-note err";
      } finally {
        btn.disabled = false;
      }
    });
  });

  // ---- Attachments dropzone (click / drag&drop / paste, max N files) ----
  const maxFiles = (module.attachments && module.attachments.max) || 3;
  const maxSizeMB = (module.attachments && module.attachments.maxSizeMB) || 20;
  document.getElementById("attachLabel").textContent = `Supporting Screenshots (Max ${maxFiles})`;
  document.getElementById("dzSub").textContent = `JPG, PNG, PDF — Max ${maxFiles} files, ${maxSizeMB}MB each`;

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const fileListEl = document.getElementById("fileList");
  let files = []; // File objects

  function renderFileList() {
    fileListEl.innerHTML = files
      .map(
        (f, i) => `<div class="file-chip"><span class="name">${f.name}</span><button type="button" data-i="${i}">&times;</button></div>`
      )
      .join("");
    fileListEl.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        files.splice(Number(btn.dataset.i), 1);
        renderFileList();
      });
    });
  }

  function addFiles(list) {
    const rejected = [];
    for (const f of list) {
      if (files.length >= maxFiles) break;
      if (f.size > maxSizeMB * 1024 * 1024) {
        rejected.push(f.name);
        continue;
      }
      files.push(f);
    }
    renderFileList();
    const status = document.getElementById("statusMsg");
    if (rejected.length) {
      status.textContent = `Skipped (over ${maxSizeMB}MB): ${rejected.join(", ")}`;
      status.className = "status-msg err";
    }
  }

  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });
  fileInput.addEventListener("change", () => addFiles(fileInput.files));

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
    })
  );
  dropzone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

  window.addEventListener("paste", (e) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.kind === "file");
    if (!items.length) return;
    addFiles(items.map((i) => i.getAsFile()).filter(Boolean));
  });

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ---- Submit ----
  const form = document.getElementById("issueForm");
  const btn = document.getElementById("submitBtn");
  const status = document.getElementById("statusMsg");

  // True for the entire duration of an in-flight submission, set the
  // instant the handler starts running (synchronously, before any
  // `await`) and cleared in `finally`. `btn.disabled` alone isn't enough
  // of a guard: on a slow/loading submit (the up-to-1-minute case agents
  // hit) a fast double-tap, or Enter-key-submit racing a button click,
  // can dispatch a SECOND "submit" event before this handler's first
  // `await` yields control back to the event loop — since the handler is
  // `async`, JS doesn't re-enter it until then, so without this flag two
  // overlapping runs can both sail past the `btn.disabled = true` line
  // and each fire a full, independent ticket submission (own
  // idempotencyKey, so the server's dedupe correctly treats them as two
  // separate legitimate submits — it has no way to know they're actually
  // the same click). That's what produces "one ticket, two Telegram
  // messages": both submissions go through in full.
  let submitInFlight = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (submitInFlight) return; // already submitting — ignore this duplicate trigger
    submitInFlight = true;
    status.textContent = "";
    status.className = "status-msg";
    btn.disabled = true;
    btn.textContent = "Submitting…";

    try {
      if (checkTidNow) {
        await checkTidNow(true);
        if (tidDuplicateInfo) {
          const parts = [tidDuplicateInfo.date, tidDuplicateInfo.pic].filter(Boolean).join(" by ");
          throw new Error(`This TID was already submitted${parts ? ` on ${parts}` : ""}. Change the TID or confirm with the team before resubmitting.`);
        }
      }

      const formData = new FormData(form);
      const fields = module.fields
        .filter((f) => !f.showIf || fieldEls[f.key].wrap.classList.contains("is-visible"))
        .map((f) => ({ key: f.key, label: f.label, value: formData.get(f.key) || "" }));

      const attachments = await Promise.all(
        files.map(async (f) => ({ name: f.name, type: f.type, dataUrl: await fileToDataUrl(f) }))
      );

      const payload = {
        module: module.id,
        brand: formData.get("brand"),
        reporter: formData.get("reporter"),
        fields,
        attachments,
        // A fresh random ID per submit CLICK (not tied to form content, so
        // resubmitting after a failure still works fine) — lets the
        // server recognize "this exact click's request landed twice"
        // (flaky network retry / double-tap / edge-node retry) and only
        // process it once. See functions/api/submit.js's idempotencyKey
        // handling for the other half of this.
        idempotencyKey: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      };

      const res = await window.AgentAuth.authFetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Submission failed");

      status.textContent = !data.sheetAttempted
        ? "Submitted — posted to Telegram."
        : data.sheetLogged
        ? "Submitted — posted to Telegram and logged to sheet."
        : `Submitted to Telegram, but sheet logging failed: ${data.sheetError || "unknown error"}`;
      status.className = data.sheetAttempted && !data.sheetLogged ? "status-msg err" : "status-msg ok";
      if (window.showToast) window.showToast(status.textContent, data.sheetAttempted && !data.sheetLogged ? "err" : "ok");
      form.reset();
      brandSelect.selectedIndex = 0;
      files = [];
      renderFileList();
      refreshConditionals();
    } catch (err) {
      status.textContent = err.message || "Something went wrong. Try again.";
      status.className = "status-msg err";
      if (window.showToast) window.showToast(status.textContent, "err");
    } finally {
      submitInFlight = false;
      // Only re-enable if the TID isn't (still) flagged as a duplicate —
      // otherwise this would silently undo the "found" state's button-disable.
      if (!tidDuplicateInfo) btn.disabled = false;
      document.getElementById("submitLabel").textContent = `Submit ${module.name}`;
    }
  });
})();
