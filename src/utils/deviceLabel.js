/**
 * SEC-18.5 - a deliberately COARSE device label.
 *
 * The audit asks for a session/device signal so an account can show "signed in
 * on a new device" and so concurrent use can be detected - the single most
 * reliable indicator that an account has been stolen.
 *
 * The obvious implementation is to store the User-Agent verbatim. That is
 * rejected here, and the reason is the point of this file: a full UA string is
 * a fingerprinting surface. It carries OS build numbers, device models and
 * library versions, which in combination identify a specific handset far more
 * precisely than "this account is being used from two places" requires. Adding
 * a high-resolution identifier to solve a low-resolution problem would trade
 * away exactly the privacy posture SEC-18.3 was careful to preserve.
 *
 * So the label is bucketed to a handful of fixed values. It answers "is this
 * the same KIND of client as before" and nothing narrower. The actual
 * concurrency signal comes from the origin hash and session timing, not from
 * this - the label exists so a human reading a session list sees something
 * meaningful rather than a hash.
 *
 * The allow-list is closed: anything unrecognised becomes "other", so a novel
 * or spoofed UA can never inject arbitrary text into a stored column that an
 * admin dashboard will later render.
 */

const MAX_LABEL_LENGTH = 24;

/**
 * Ordered because the first match wins and some UAs legitimately match more
 * than one pattern - a Flutter app on Android sends both "Dart" and "Android",
 * and the app is the more useful answer.
 */
const RULES = [
  [/\bdart\b|\bflutter\b/i, "mobile-app"],
  [/\bokhttp\b/i, "mobile-app"],
  [/\bcfnetwork\b|\bdarwin\b/i, "ios"],
  [/\bandroid\b/i, "android"],
  [/\biphone\b|\bipad\b|\bios\b/i, "ios"],
  [/\bedg\//i, "web-edge"],
  [/\bchrome\//i, "web-chrome"],
  [/\bfirefox\//i, "web-firefox"],
  [/\bsafari\//i, "web-safari"],
  [/\bcurl\b|\bwget\b|\bpostman\b|\binsomnia\b/i, "tool"],
  [/\bbot\b|\bcrawler\b|\bspider\b/i, "bot"],
];

/**
 * @returns {string} one of the fixed labels above, or "unknown" when no
 *   User-Agent was sent. Never returns caller-supplied text.
 */
function deviceLabelFor(req) {
  const raw = req && req.headers && req.headers["user-agent"];
  if (typeof raw !== "string" || !raw.trim()) return "unknown";

  // Bounded before matching: a pathological multi-megabyte UA header should
  // cost a slice, not a dozen regex scans over the whole thing.
  const ua = raw.slice(0, 512);

  for (const [pattern, label] of RULES) {
    if (pattern.test(ua)) return label;
  }
  return "other";
}

module.exports = { deviceLabelFor, MAX_LABEL_LENGTH };
