/** Shared interactive UI helpers for pi-hooks extensions. */
/** Return the zero-based option selected by a single number key, if any. */
export function numberedOptionIndex(data: string, optionCount: number): number | undefined {
  if (data.length !== 1 || optionCount <= 0) return undefined;
  const code = data.charCodeAt(0);
  if (code < 49 || code > 57) return undefined;
  const index = code - 49;
  return index < optionCount ? index : undefined;
}

/**
 * A small wrapper around the current pi `ui.custom` API. It preserves normal
 * keyboard navigation while making short prompts faster with 1-9 shortcuts.
 */
export async function numberedSelect(
  ctx: { ui: {
    custom?: <T>(factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any) => Promise<T>;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
  } },
  title: string,
  options: string[],
): Promise<string | null> {
  if (options.length === 0) return null;
  // Keep compatibility with lightweight test hosts and older pi contexts that
  // expose select() but not custom(). The current pi API takes the numbered path.
  if (!ctx.ui.custom) return ctx.ui.select ? ctx.ui.select(title, options).then((value) => value ?? null) : null;
  return ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    let selected = 0;
    let lines: string[] = [];
    const update = () => {
      lines = [title, ""];
      for (let i = 0; i < options.length; i++) {
        const marker = i === selected ? "▸" : " ";
        lines.push(`  ${i + 1}. ${marker} ${options[i]}`);
      }
    };
    update();

    return {
      render: (width: number) => lines.map((line) => {
        if (width <= 0 || line.length <= width) return line;
        return `${line.slice(0, Math.max(0, width - 1))}…`;
      }),
      invalidate: () => {},
      handleInput: (data: string) => {
        const index = numberedOptionIndex(data, options.length);
        if (index !== undefined) {
          done(options[index]);
          return;
        }
        if (keybindings.matches(data, "tui.select.down") || data === "j") {
          selected = (selected + 1) % options.length;
          update();
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.up") || data === "k") {
          selected = (selected - 1 + options.length) % options.length;
          update();
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
          done(options[selected]);
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel")) done(null);
      },
    };
  });
}
