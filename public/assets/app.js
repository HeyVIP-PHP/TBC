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

  module.fields.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "field" + (f.emphasize ? " field-emphasize" : "");
    if (f.showIf) wrap.setAttribute("data-conditional", "true");

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

    // Base required state (conditional fields only become required once visible+required)
    if (f.required && !f.showIf) fieldEls[f.key].control.required = true;
  });

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
  function refreshConditionals() {
    module.fields.forEach((f) => {
      if (!f.showIf) return;
      const visible = conditionMet(f.showIf);
      const { wrap, control } = fieldEls[f.key];
      wrap.classList.toggle("is-visible", visible);
      control.required = visible && !!f.required;
      if (!visible) control.value = "";
    });
    refreshAutoFilledAmounts();
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
      btn.disabled = false;
      document.getElementById("submitLabel").textContent = `Submit ${module.name}`;
    }
  });
})();
