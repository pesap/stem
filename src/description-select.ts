import {
  CANCEL_SYMBOL as CORE_CANCEL_SYMBOL,
  SelectPrompt,
  getColumns,
  type State,
  wrapTextWithPrefix,
} from "@clack/core";
import { CANCEL_SYMBOL as PROMPT_CANCEL_SYMBOL } from "@clack/prompts";
import { styleText } from "node:util";

export interface DescriptionChoice<Value extends string> {
  value: Value;
  label: string;
  description: string;
}

export interface DescriptionSelectView<Value extends string> {
  cursor: number;
  state: State;
  value: Value | undefined;
  options: readonly DescriptionChoice<Value>[];
}

export async function selectWithDescription<Value extends string>(options: {
  message: string;
  choices: DescriptionChoice<Value>[];
  initialValue: Value;
}): Promise<Value | typeof PROMPT_CANCEL_SYMBOL> {
  const result = await new SelectPrompt<DescriptionChoice<Value>>({
    options: options.choices,
    initialValue: options.initialValue,
    render() {
      return renderDescriptionSelect(this, options.message);
    },
  }).prompt();
  return result === undefined || result === CORE_CANCEL_SYMBOL
    ? PROMPT_CANCEL_SYMBOL
    : result;
}

export function renderDescriptionSelect<Value extends string>(
  view: DescriptionSelectView<Value>,
  message: string,
): string {
  const isActive =
    view.state === "initial" ||
    view.state === "active" ||
    view.state === "error" ||
    view.state === "validating";
  const icon =
    view.state === "submit"
      ? styleText("green", "◇")
      : view.state === "cancel"
        ? styleText("red", "■")
        : styleText("green", "◆");
  const rail = "│";
  const styledRail = styleText("gray", rail);
  const lines = [`${icon}  ${message}`];

  if (!isActive) {
    const selected =
      view.options.find((option) => option.value === view.value) ??
      view.options[view.cursor];
    if (selected !== undefined) {
      lines.push(`${rail}  ${selected.label}`);
    }
    return lines.join("\n");
  }

  lines.push(styledRail);
  for (const [index, option] of view.options.entries()) {
    const focused = index === view.cursor;
    const pointer = focused ? styleText("cyan", "❯") : " ";
    const marker = focused ? styleText("green", "●") : styleText("gray", "○");
    const label = focused ? option.label : styleText("gray", option.label);
    lines.push(`${styledRail} ${pointer} ${marker} ${label}`);
  }
  lines.push(`${styledRail}  ↑/↓ to navigate • Enter: confirm`);
  lines.push(styledRail);
  lines.push(`${styledRail}  ${styleText("dim", "Description")}`);
  const focused = view.options[view.cursor];
  if (focused !== undefined) {
    const descriptionLines = wrapTextWithPrefix(
      process.stdout,
      focused.description,
      `${rail}  `,
      `${rail}  `,
      `${rail}  `,
    );
    lines.push(
      ...descriptionLines.split("\n").map((line) => styleText("dim", line)),
    );
  }
  const borderWidth = Math.max(1, getColumns(process.stdout) - 2);
  lines.push(styleText("gray", `└${"─".repeat(borderWidth)}┘`));
  return lines.join("\n");
}
