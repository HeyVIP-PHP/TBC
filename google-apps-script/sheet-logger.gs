/**
 * Deploy this bound to each brand's Google Sheet:
 *   Extensions > Apps Script > paste this in > Deploy > New deployment
 *   Type: Web app | Execute as: Me | Who has access: Anyone with the link
 * Copy the resulting /exec URL into that brand's `sheetWebhookUrl` in
 * functions/_shared/routing.js on the Worker side.
 *
 * Each module writes to its own tab (created automatically the first time
 * a submission for that module comes in), so Account Issue / Promotion
 * Request / Daily Report don't collide with each other.
 */
function doPost(e) {
  const row = JSON.parse(e.postData.contents);
  const sheetName = row.module || "submissions";

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    const headers = ["timestamp", "brand", "reporter", ...Object.keys(row).filter(
      (k) => !["module", "brand", "reporter", "timestamp"].includes(k)
    )];
    sheet.appendRow(headers);
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = headers.map((h) => row[h] ?? "");
  sheet.appendRow(values);

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
