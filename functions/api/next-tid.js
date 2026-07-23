import { PROMOTION_SHEET_CONFIG } from "../_shared/routing.js";
import { getNextSequenceValue } from "../_shared/googleSheets.js";
import { verifyRequest } from "../_shared/accounts.js";

export async function onRequestPost(context) {
  try {
    return await handleNextTid(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleNextTid({ request, env }) {
  // Whole hub requires login now — see submit.js for the same note.
  const account = await verifyRequest(request, env);
  if (!account) return json({ ok: false, error: "Login required." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const { module: moduleId, brand: brandId, promotion } = body || {};
  if (moduleId !== "promotion_request") {
    return json({ ok: false, error: "Not supported for this module." }, 400);
  }

  const config = PROMOTION_SHEET_CONFIG[`${brandId}|${promotion}`];
  if (!config) {
    return json({ ok: false, error: "Not configured yet for this brand + promotion combination." }, 400);
  }

  try {
    const result = await getNextSequenceValue(env, config.sheetId, config.tab, config.tidColumn || config.startColumn);
    if (!result.next) {
      return json({ ok: false, error: result.error || "Could not determine the next value." }, 500);
    }
    return json({
      ok: true,
      value: result.next,
      message: `Row ${result.lastRowNumber + 1} — Available (previous: ${result.previous})`,
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
