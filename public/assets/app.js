(function () {
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

  // Real enforcement, not just hiding it from the sidebar — an agent
  // scoped away from this Topic (account.allowedModules, see
  // authguard.js's filterAllowedModules) who directly types/pastes this
  // module's URL still gets blocked here, before the form even renders.
  // submit.js has the actual server-side check that matters (this is
  // just a friendlier "Not available" message instead of a raw 403 after
  // filling out the whole form).
  if (window.AgentAuth && window.AgentAuth.filterAllowedModules([module]).length === 0) {
    titleEl.textContent = "Not available";
    hintEl.textContent = "You don't have access to this Topic. Contact a SuperAdmin if you think this is a mistake.";
    formCard.querySelector("form").style.display = "none";
    return;
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
      fieldEls[f.key].control.value = new Date().toISOString().slice(0, 10);
    }

    // Base required state (conditional/gated fields only become required once visible+required)
    if (f.required && !isGated) fieldEls[f.key].control.required = true;
  });

  // ---- Withdraw Issue: duplicate-TID guard ----
  // See functions/api/check-tid.js for the full write-up. Two check
  // points: onBlur (early warning — see the listener below) and again
  // right before actually submitting (final guard below, in the submit
  // handler) — a fresh check right before submit covers the agent never
  // blurring the field, or pasting a new value and hitting Submit
  // without tabbing away first.
  let tidDuplicateInfo = null; // { date, pic } while the CURRENT tid value is a known duplicate, else null
  let checkTidNow = null; // set below only for the Withdraw Issue module; read by the submit handler further down
  let tidCheckSeq = 0; // ignores a stale response if the agent kept typing/re-checking before an earlier check came back
  if (module.id === "withdraw_issue" && fieldEls.tid) {
    const tidLabel = fieldEls.tid.wrap.querySelector("label");
    const tidWarning = document.createElement("span");
    tidWarning.className = "tid-warning";
    tidWarning.id = "tidWarning";
    tidLabel.appendChild(tidWarning);
    const submitBtn = document.getElementById("submitBtn");

    // One place that sets ALL of: the warning text, the TID input's red
    // border, and whether Submit is clickable — so these three things
    // can never drift out of sync with each other (e.g. a red border
    // left on-screen after the warning text was cleared).
    function setTidState(state, text) {
      tidWarning.textContent = text || "";
      tidWarning.className = "tid-warning" + (state ? ` ${state}` : "");
      fieldEls.tid.control.classList.toggle("field-error", state === "found");
      if (state === "found") {
        submitBtn.disabled = true;
        submitBtn.title = "This TID was already submitted — change it before continuing.";
      } else if (submitBtn.title) {
        // Only clear OUR disabled-reason, never a disabled state some
        // other part of the page set for its own reason (e.g. mid-submit).
        submitBtn.disabled = false;
        submitBtn.title = "";
      }
    }

    async function checkTid(showChecking) {
      const brandId = brandSelect.value;
      const tid = fieldEls.tid.control.value.trim();
      tidDuplicateInfo = null;
      if (!brandId || !tid) {
        setTidState(null, "");
        return null;
      }
      const seq = ++tidCheckSeq;
      if (showChecking) setTidState("checking", "checking…");
      let data;
      try {
        const res = await window.AgentAuth.authFetch(`/api/check-tid?brand=${encodeURIComponent(brandId)}&tid=${encodeURIComponent(tid)}`);
        data = await res.json();
      } catch {
        data = { ok: false };
      }
      if (seq !== tidCheckSeq) return null; // a newer check superseded this one — ignore
      if (!data.ok) {
        setTidState(null, "");
        return null;
      }
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
    // Typing again after a duplicate was flagged clears the red border/
    // disabled Submit right away, rather than leaving them stuck until
    // the NEXT blur — the agent shouldn't have to click away just to see
    // that Submit is usable again after fixing the value.
    fieldEls.tid.control.addEventListener("input", () => {
      if (tidDuplicateInfo) setTidState(null, "");
    });
    // Brand changing invalidates whatever the TID field last checked
    // against (it was checking the OLD brand's sheet) — clear it rather
    // than leave a stale warning that no longer means anything until the
    // agent touches the TID field again.
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
  // combo with no selector needed (e.g. Crickex Birthday Bonus), then (2)
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    status.textContent = "";
    status.className = "status-msg";
    btn.disabled = true;
    btn.textContent = "Submitting…";

    try {
      // Withdraw Issue: final duplicate-TID guard, right before actually
      // submitting — re-checks the CURRENT tid value even if the field
      // was never blurred (pasted + hit Submit directly) or was changed
      // back to a previously-flagged value without a fresh blur. See
      // functions/api/check-tid.js for why this reads the Sheet, and the
      // field-setup block above for the onBlur early-warning half of this.
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
        // A fresh random ID per submit ATTEMPT (not per form/ticket) — lets
        // the server (see submit.js) recognize "this exact click's request
        // arrived twice" (flaky mobile network retransmit, a double-tap
        // the button-disable below didn't quite catch, etc) and only ever
        // create one Telegram message / Sheet row / thread record for it,
        // instead of two identical tickets. crypto.randomUUID() isn't
        // available on very old browsers/insecure contexts — falls back to
        // Math.random() in that case, which is fine here since this only
        // needs to be unique per click, not cryptographically unguessable.
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
      form.reset();
      brandSelect.selectedIndex = 0;
      files = [];
      renderFileList();
      refreshConditionals();
    } catch (err) {
      status.textContent = err.message || "Something went wrong. Try again.";
      status.className = "status-msg err";
    } finally {
      // Don't blindly re-enable — if the TID check above is still
      // flagging a duplicate (the catch just above fired specifically
      // because of that), setTidState() already put Submit into its own
      // disabled state with its own reason; stepping on that here would
      // make the button clickable again while the red border/warning
      // are still showing, which is exactly the inconsistent state
      // setTidState() exists to prevent.
      if (!tidDuplicateInfo) btn.disabled = false;
      document.getElementById("submitLabel").textContent = `Submit ${module.name}`;
    }
  });
})();
