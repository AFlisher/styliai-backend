/**
 * Escapes the five HTML special characters so user-supplied values (e.g.
 * full_name) can be safely interpolated into HTML email bodies (audit
 * finding #10).
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = escapeHtml;
