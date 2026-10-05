// An embed's settings form: a row for each argument its contribution declares (text, a number, a
// duration with presets, a choice, a switch), with the markdown it'll write as you go. Save hands back
// the values that changed; arguments left at their default and not already written stay out.
import type { EmbedArgument, EmbedContribution } from "../../worker/src/extensions.ts";
import { attrsRecord, withValues, type Attr } from "./directives.ts";

/** A duration as embeds write them: 90s, 25m, 1h30m. */
export const isDuration = (v: string) => /^(?=\d)(\d+h)?(\d+m)?(\d+s)?$/.test(v);

const label = (key: string, a: EmbedArgument) => a.label ?? key[0].toUpperCase() + key.slice(1);

/** Whether a value is one an argument can take: blank (its default), or the right shape for its type. */
function valid(a: EmbedArgument, value: string): boolean {
  if (!value) return true;
  if (a.type === "duration") return isDuration(value);
  if (a.type === "number") return Number.isFinite(Number(value));
  if (a.enum) return a.enum.includes(value);
  return true;
}

export function embedForm(
  contribution: EmbedContribution,
  attrs: readonly Attr[],
  on: { preview(attrs: Attr[]): string; save(values: Record<string, string | undefined>): void; cancel(): void },
): HTMLFormElement {
  const fields = Object.entries(contribution.arguments).filter(([, a]) => !a.hidden);
  const written = attrsRecord(attrs);
  const values: Record<string, string> = Object.fromEntries(fields.map(([key, a]) => [key, written[key] ?? a.default ?? ""]));
  const form = document.createElement("form");
  form.className = "cm-embed-form";
  form.setAttribute("aria-label", `${contribution.title}'s settings`);
  const preview = document.createElement("code");
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Save";

  /** What Save writes: a value that isn't its default, or one already written; a blank takes it out. */
  const changes = (): Record<string, string | undefined> =>
    Object.fromEntries(
      fields.map(([key, a]) => {
        const v = values[key];
        return [key, !v || (v === (a.default ?? "") && !(key in written)) ? undefined : v];
      }),
    );
  const refresh = () => {
    const ok = fields.every(([key, a]) => valid(a, values[key]));
    save.disabled = !ok;
    preview.textContent = ok ? on.preview(withValues(attrs, changes())) : "Durations look like 90s, 25m or 1h30m";
    preview.classList.toggle("is-error", !ok);
  };

  for (const [key, a] of fields) {
    const id = `embed-${contribution.language}-${key}-${Math.random().toString(36).slice(2, 8)}`;
    const name = document.createElement("label");
    name.htmlFor = id;
    name.textContent = label(key, a);
    let control: HTMLInputElement | HTMLSelectElement;
    if (a.type === "boolean") {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = values[key] === "true";
      box.addEventListener("change", () => {
        values[key] = box.checked ? "true" : "false";
        refresh();
      });
      control = box;
    } else if (a.enum) {
      const select = document.createElement("select");
      for (const v of a.enum) select.append(new Option(v, v, false, v === values[key]));
      select.addEventListener("change", () => {
        values[key] = select.value;
        refresh();
      });
      control = select;
    } else {
      const input = document.createElement("input");
      input.type = a.type === "number" ? "number" : "text";
      if (a.type === "number") input.step = "any";
      input.value = values[key];
      input.placeholder = a.default ?? "";
      input.spellcheck = false;
      input.addEventListener("input", () => {
        values[key] = input.value.trim();
        refresh();
      });
      control = input;
    }
    control.id = id;
    if (a.description) control.title = a.description;
    form.append(name, control);
    if (a.presets?.length) {
      const presets = document.createElement("div");
      presets.className = "presets";
      for (const p of a.presets) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = p;
        b.addEventListener("click", () => {
          (control as HTMLInputElement).value = p;
          values[key] = p;
          refresh();
        });
        presets.append(b);
      }
      form.append(presets);
    }
    if (a.description) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = a.description;
      form.append(hint);
    }
  }

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => on.cancel());
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(preview, cancel, save);
  form.append(actions);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!save.disabled) on.save(changes());
  });
  // Keys typed here are the form's, not the note's (or Vim's).
  form.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      on.cancel();
    }
  });
  refresh();
  return form;
}
