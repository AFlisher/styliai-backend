/**
 * Dynamic Prompt Template Engine.
 *
 * A style's prompt may contain {{placeholder}} tokens. At generation time the
 * server (never the client) validates the user's submitted values against the
 * style's configured field definitions and substitutes them in, producing the
 * final prompt sent to the AI provider.
 *
 * Guarantees:
 *  - A prompt with no placeholders is returned unchanged (backward compatible).
 *  - Every placeholder in the prompt must have a configured field, else reject.
 *  - Every required field must have a value, else reject.
 *  - Submitted values for undefined fields are rejected (never trust client).
 *  - User values can never introduce new placeholders (braces are stripped),
 *    so a value can't inject another token or reopen the template.
 *  - The final prompt is asserted to contain no residual {{...}} tokens.
 */

// A placeholder key is a simple identifier: letters, digits, underscore.
const PLACEHOLDER_SOURCE = "\\{\\{\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\}\\}";

const SUPPORTED_FIELD_TYPES = new Set([
  "text",
  "textarea",
  "number",
  "dropdown",
  "checkbox",
  "color",
  "date",
]);

const DEFAULT_MAX_LENGTH = 500;

class PromptValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "PromptValidationError";
    this.field = field || null;
    this.isPromptValidationError = true;
  }
}

/** Returns the Set of distinct placeholder keys referenced in a prompt. */
function extractPlaceholders(prompt) {
  const keys = new Set();
  if (!prompt) return keys;
  const re = new RegExp(PLACEHOLDER_SOURCE, "g");
  let m;
  while ((m = re.exec(prompt)) !== null) keys.add(m[1]);
  return keys;
}

/** True if the string still contains any {{...}} token or stray brace pair. */
function hasResidualPlaceholder(text) {
  return new RegExp(PLACEHOLDER_SOURCE).test(text) || /\{\{|\}\}/.test(text);
}

/** Normalizes dropdown options to a [{ value, label }] array. */
function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => {
      if (o == null) return null;
      if (typeof o === "string" || typeof o === "number") {
        return { value: String(o), label: String(o) };
      }
      if (typeof o === "object" && o.value !== undefined) {
        return { value: String(o.value), label: String(o.label ?? o.value) };
      }
      return null;
    })
    .filter(Boolean);
}

/** Normalizes a stored/submitted field definition into a consistent shape. */
function normalizeField(field) {
  const key = field.key ?? field.field_key;
  return {
    key,
    label: field.label || key,
    type: SUPPORTED_FIELD_TYPES.has(field.type) ? field.type : "text",
    required: Boolean(field.required),
    placeholder: field.placeholder ?? null,
    options: normalizeOptions(field.options),
    config: field.config && typeof field.config === "object" ? field.config : {},
    sortOrder: field.sortOrder ?? field.sort_order ?? 0,
  };
}

/**
 * Strips anything a user value could use to break out of / inject into the
 * template, then trims and length-caps it.
 */
function sanitizeValue(raw, field) {
  let v = String(raw ?? "");
  // Remove braces so a value can never form a {{token}} or reopen one.
  v = v.replace(/[{}]/g, "");
  // Replace control characters (incl. newlines/tabs) with spaces - the final
  // prompt is a single string, so raw control chars are never kept.
  v = v.replace(/[\u0000-\u001F\u007F]/g, " ");
  // Collapse whitespace and trim.
  v = v.replace(/\s+/g, " ").trim();
  const maxLen = Number(field.config?.maxLength) > 0 ? Number(field.config.maxLength) : DEFAULT_MAX_LENGTH;
  if (v.length > maxLen) v = v.slice(0, maxLen);
  return v;
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Validates a single submitted value against its field type and coerces it to
 * the string that will be substituted into the prompt.
 */
function validateAndCoerce(field, rawValue) {
  switch (field.type) {
    case "number": {
      const n = Number(rawValue);
      if (!Number.isFinite(n)) {
        throw new PromptValidationError(`"${field.label}" must be a number.`, field.key);
      }
      const { min, max } = field.config || {};
      if (min !== undefined && min !== null && n < Number(min)) {
        throw new PromptValidationError(`"${field.label}" must be at least ${min}.`, field.key);
      }
      if (max !== undefined && max !== null && n > Number(max)) {
        throw new PromptValidationError(`"${field.label}" must be at most ${max}.`, field.key);
      }
      return String(n);
    }
    case "checkbox": {
      const truthy = rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true";
      const falsy = rawValue === false || rawValue === 0 || rawValue === "0" || rawValue === "false";
      if (!truthy && !falsy) {
        throw new PromptValidationError(`"${field.label}" must be true or false.`, field.key);
      }
      const trueText = field.config?.trueText ?? "yes";
      const falseText = field.config?.falseText ?? "no";
      return sanitizeValue(truthy ? trueText : falseText, field);
    }
    case "dropdown": {
      const v = String(rawValue);
      if (!field.options.some((o) => o.value === v)) {
        throw new PromptValidationError(`"${field.label}" must be one of the allowed options.`, field.key);
      }
      return sanitizeValue(v, field);
    }
    case "color": {
      const v = String(rawValue).trim();
      if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) {
        throw new PromptValidationError(`"${field.label}" must be a valid hex color (e.g. #A855F7).`, field.key);
      }
      return v;
    }
    case "date": {
      const v = String(rawValue).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
        throw new PromptValidationError(`"${field.label}" must be a valid date (YYYY-MM-DD).`, field.key);
      }
      return v;
    }
    case "text":
    case "textarea":
    default: {
      const v = sanitizeValue(rawValue, field);
      const minLength = Number(field.config?.minLength);
      if (Number.isFinite(minLength) && minLength > 0 && v.length < minLength) {
        throw new PromptValidationError(`"${field.label}" must be at least ${minLength} characters.`, field.key);
      }
      const pattern = field.config?.regex;
      if (typeof pattern === "string" && pattern.trim() !== "") {
        let re = null;
        try {
          re = new RegExp(pattern);
        } catch (e) {
          re = null; // a malformed admin regex must never crash generation
        }
        if (re && !re.test(v)) {
          throw new PromptValidationError(`"${field.label}" is not in the expected format.`, field.key);
        }
      }
      return v;
    }
  }
}

/**
 * Save-time check (admin): every {{placeholder}} in the prompt must have a
 * matching field. Throws listing the unbacked placeholders. An unused field
 * (defined but not referenced) is intentionally NOT an error here - the
 * dashboard surfaces that as a non-blocking warning.
 */
function validatePromptFields(prompt, fields = []) {
  const keys = new Set(
    (fields || []).map((f) => f.key ?? f.field_key).filter(Boolean)
  );
  const missing = [...extractPlaceholders(prompt)].filter((k) => !keys.has(k));
  if (missing.length > 0) {
    throw new PromptValidationError(
      `Prompt references placeholder(s) with no matching field: ${missing.map((k) => `{{${k}}}`).join(", ")}.`
    );
  }
  return true;
}

/**
 * Builds the final prompt.
 *
 * @param {Object} args
 * @param {string} args.prompt   - the style's raw prompt (may contain {{tokens}})
 * @param {Array}  args.fields   - the style's field definitions
 * @param {Object} args.values   - user-submitted values keyed by field key
 * @returns {string} the resolved prompt, guaranteed free of placeholders
 * @throws {PromptValidationError}
 */
function buildFinalPrompt({ prompt, fields = [], values = {} } = {}) {
  const rawPrompt = prompt || "";
  const byKey = new Map();
  for (const f of fields || []) {
    const nf = normalizeField(f);
    if (nf.key) byKey.set(nf.key, nf);
  }

  const submitted = values && typeof values === "object" ? values : {};

  // Never trust the client: a value for a key with no defined field is rejected.
  for (const key of Object.keys(submitted)) {
    if (!byKey.has(key)) {
      throw new PromptValidationError(`Unknown field "${key}".`, key);
    }
  }

  // Every placeholder in the prompt must map to a configured field.
  const placeholders = extractPlaceholders(rawPrompt);
  for (const key of placeholders) {
    if (!byKey.has(key)) {
      throw new PromptValidationError(`Prompt references unknown placeholder "{{${key}}}" with no configured field.`, key);
    }
  }

  // Validate + resolve each configured field.
  const resolved = {};
  for (const [key, field] of byKey) {
    if (isBlank(submitted[key])) {
      if (field.required) {
        throw new PromptValidationError(`"${field.label}" is required.`, key);
      }
      // Optional & blank: fall back to a configured default (if any) so a
      // referenced placeholder never resolves to a leftover token.
      resolved[key] = field.config?.default != null ? sanitizeValue(field.config.default, field) : "";
      continue;
    }
    resolved[key] = validateAndCoerce(field, submitted[key]);
  }

  // Substitute. A function replacer keeps user values literal (no $-group
  // interpretation) and replaces every occurrence of duplicated tokens.
  const re = new RegExp(PLACEHOLDER_SOURCE, "g");
  const out = rawPrompt.replace(re, (_match, key) => (resolved[key] !== undefined ? resolved[key] : ""));

  // Never send unresolved placeholders.
  if (hasResidualPlaceholder(out)) {
    throw new PromptValidationError("The prompt still contains unresolved placeholders.");
  }

  return out;
}

/**
 * Validates an admin-supplied field definition (used when saving a style's
 * fields). Throws PromptValidationError on any problem.
 */
function validateFieldDefinition(field, index = 0) {
  const where = `field #${index + 1}`;
  if (!field || typeof field !== "object") {
    throw new PromptValidationError(`${where} is invalid.`);
  }
  const key = field.key ?? field.field_key;
  if (!key || !/^[a-z][a-z0-9_]*$/.test(key)) {
    throw new PromptValidationError(`${where}: key must be lower_snake_case starting with a letter (got "${key}").`);
  }
  if (!field.label || String(field.label).trim() === "") {
    throw new PromptValidationError(`${where}: a label is required.`);
  }
  const type = field.type || "text";
  if (!SUPPORTED_FIELD_TYPES.has(type)) {
    throw new PromptValidationError(`${where}: unsupported type "${type}".`);
  }
  if (type === "dropdown") {
    const opts = normalizeOptions(field.options);
    if (opts.length === 0) {
      throw new PromptValidationError(`${where}: a dropdown must define at least one option.`);
    }
  }
  return true;
}

/** Rejects duplicate keys within a field-definition set. */
function assertUniqueKeys(fields = []) {
  const seen = new Set();
  fields.forEach((f, i) => {
    validateFieldDefinition(f, i);
    const key = f.key ?? f.field_key;
    if (seen.has(key)) {
      throw new PromptValidationError(`Duplicate field key "${key}".`, key);
    }
    seen.add(key);
  });
  return true;
}

module.exports = {
  PromptValidationError,
  SUPPORTED_FIELD_TYPES,
  extractPlaceholders,
  normalizeField,
  normalizeOptions,
  sanitizeValue,
  buildFinalPrompt,
  validateFieldDefinition,
  assertUniqueKeys,
  validatePromptFields,
};
