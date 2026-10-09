import {
  AutocompletePrompt,
  CANCEL_SYMBOL as CORE_CANCEL_SYMBOL,
  getColumns,
  getRows,
  type State,
  wrapTextWithPrefix,
} from "@clack/core";
import { CANCEL_SYMBOL as PROMPT_CANCEL_SYMBOL } from "@clack/prompts";
import { styleText } from "node:util";

const SELECT_ALL = Symbol("select-all");
const MAX_VISIBLE_ENTRIES = 10;

export interface MultiSelectEntry {
  value: string;
  label: string;
  hint?: string;
}

interface SelectAllOption {
  value: typeof SELECT_ALL;
  label: string;
}

type MultiSelectOption = SelectAllOption | MultiSelectEntry;

export interface SelectAllMenuView {
  state: State;
  search: string;
  focused: { type: "select-all" } | { type: "item"; value: string } | undefined;
  visibleEntries: readonly MultiSelectEntry[];
  selectedValues: ReadonlySet<string>;
  totalItems: number;
}

export async function selectAllMultiselect(
  message: string,
  entries: MultiSelectEntry[],
): Promise<string[] | typeof PROMPT_CANCEL_SYMBOL> {
  const values = entries.map((entry) => entry.value);
  const prompt = new AutocompletePrompt<MultiSelectOption>({
    options: [{ value: SELECT_ALL, label: "Select All" }, ...entries],
    multiple: true,
    filter(search, option) {
      if (option.value === SELECT_ALL || search === "") {
        return true;
      }
      const query = search.toLowerCase();
      return (
        option.label.toLowerCase().includes(query) ||
        String(option.value).toLowerCase().includes(query) ||
        (option.hint?.toLowerCase().includes(query) ?? false)
      );
    },
    render() {
      const filteredEntries = this.filteredOptions.filter(
        (option): option is MultiSelectEntry => option.value !== SELECT_ALL,
      );
      const focusedIndex = filteredEntries.findIndex(
        (entry) => entry.value === this.focusedValue,
      );
      const visibleCount = Math.max(
        3,
        Math.min(MAX_VISIBLE_ENTRIES, getRows(process.stdout) - 13),
      );
      const visibleStart = Math.max(
        0,
        Math.min(
          focusedIndex - Math.floor(visibleCount / 2),
          filteredEntries.length - visibleCount,
        ),
      );
      const visibleEntries = filteredEntries.slice(
        visibleStart,
        visibleStart + visibleCount,
      );
      const selectedValues = new Set(
        this.selectedValues.filter(
          (value): value is string => typeof value === "string",
        ),
      );
      const focused =
        this.focusedValue === SELECT_ALL
          ? { type: "select-all" as const }
          : typeof this.focusedValue === "string"
            ? { type: "item" as const, value: this.focusedValue }
            : undefined;

      return renderSelectAllMenu(message, {
        state: this.state,
        search: this.userInput,
        focused,
        visibleEntries,
        selectedValues,
        totalItems: entries.length,
      });
    },
  });
  prompt.isNavigating = true;
  prompt.on("userInput", (input) => {
    prompt.isNavigating = input === "";
  });

  prompt.on("key", (_input, key) => {
    const selectingWithSpace = key?.name === "space" && prompt.isNavigating;
    const selectingWithTab = key?.name === "tab";
    if (
      (!selectingWithSpace && !selectingWithTab) ||
      prompt.focusedValue !== SELECT_ALL
    ) {
      return;
    }

    const selectedValues = new Set(
      prompt.selectedValues.filter(
        (value): value is string => typeof value === "string",
      ),
    );
    const updatedValues = toggleAllValues(selectedValues, values);
    prompt.deselectAll();
    for (const value of updatedValues) {
      prompt.toggleSelected(value);
    }
  });

  const result = await prompt.prompt();
  if (result === undefined || result === CORE_CANCEL_SYMBOL) {
    return PROMPT_CANCEL_SYMBOL;
  }
  const selected = Array.isArray(result) ? result : [result];
  return selected.filter((value): value is string => typeof value === "string");
}

export function toggleAllValues(
  selected: ReadonlySet<string>,
  values: readonly string[],
): Set<string> {
  const selectAll = !values.every((value) => selected.has(value));
  const updated = new Set(selected);
  for (const value of values) {
    if (selectAll) {
      updated.add(value);
    } else {
      updated.delete(value);
    }
  }
  return updated;
}

export function renderSelectAllMenu(
  message: string,
  view: SelectAllMenuView,
): string {
  const active = view.state === "initial" || view.state === "active";
  const icon =
    view.state === "submit"
      ? styleText("green", "◇")
      : view.state === "cancel"
        ? styleText("red", "■")
        : styleText("green", "◆");
  const rail = styleText("gray", "│");
  const lines = [`${icon}  ${message}`];

  if (!active) {
    const summary =
      view.selectedValues.size === 0
        ? "(none)"
        : `${view.selectedValues.size} selected`;
    lines.push(`${rail}  ${summary}`);
    return lines.join("\n");
  }

  lines.push(`${rail}  Search: ${view.search || "Type to search..."}`);
  lines.push(`${rail}  ↑↓ move, space select, enter confirm`);
  lines.push(rail);

  const selectedCount = view.selectedValues.size;
  const selectAllFocused = view.focused?.type === "select-all";
  const selectAllMarker =
    selectedCount === view.totalItems
      ? styleText("green", "●")
      : selectedCount > 0
        ? styleText("yellow", "◐")
        : styleText("gray", "○");
  const selectAllPointer = selectAllFocused ? styleText("cyan", "❯") : " ";
  const selectAllLabel = selectAllFocused
    ? styleText("bold", "Select All")
    : "Select All";
  lines.push(
    `${rail} ${selectAllPointer} ${selectAllMarker} ${selectAllLabel} (${selectedCount}/${view.totalItems})`,
  );
  const dividerWidth = Math.max(
    1,
    Math.min(40, getColumns(process.stdout) - 6),
  );
  lines.push(`${rail}   ${styleText("gray", "─".repeat(dividerWidth))}`);

  if (view.visibleEntries.length === 0) {
    lines.push(`${rail}  No matching options`);
  }
  for (const entry of view.visibleEntries) {
    const focused =
      view.focused?.type === "item" && view.focused.value === entry.value;
    const pointer = focused ? styleText("cyan", "❯") : " ";
    const marker = view.selectedValues.has(entry.value)
      ? styleText("green", "●")
      : styleText("gray", "○");
    const hint =
      entry.hint === undefined ? "" : ` ${styleText("dim", `(${entry.hint})`)}`;
    lines.push(`${rail} ${pointer} ${marker} ${entry.label}${hint}`);
  }

  lines.push(rail);
  lines.push(`${rail}  ${styleText("dim", "Description")}`);
  const focused = view.focused;
  const description =
    focused?.type === "select-all"
      ? `Select or clear all ${view.totalItems} options.`
      : focused?.type === "item"
        ? (view.visibleEntries.find((entry) => entry.value === focused.value)
            ?.hint ?? focused.value)
        : "Search or select an option.";
  const descriptionLines = wrapTextWithPrefix(
    process.stdout,
    description,
    "│  ",
    "│  ",
    "│  ",
  );
  lines.push(
    ...descriptionLines.split("\n").map((line) => styleText("dim", line)),
  );
  const borderWidth = Math.max(1, getColumns(process.stdout) - 2);
  lines.push(styleText("gray", `└${"─".repeat(borderWidth)}┘`));
  return lines.join("\n");
}
