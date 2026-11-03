const TEXT_INPUT_TYPES = new Set([
  "text",
  "number",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

/** Global editor shortcuts should yield only while a text-like field is being edited. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  const element = target && typeof (target as Element).closest === "function" ? target as Element : null;
  if (!element) return false;
  const editable = element.closest("[contenteditable]");
  if (editable && editable.getAttribute("contenteditable") !== "false") return true;
  const field = element.closest("input, textarea");
  if (!field) return false;
  if (field.tagName.toLocaleLowerCase() === "textarea") return true;
  if (field.tagName.toLocaleLowerCase() !== "input") return false;
  const type = field.getAttribute("type")?.toLocaleLowerCase() || "text";
  return TEXT_INPUT_TYPES.has(type);
}
