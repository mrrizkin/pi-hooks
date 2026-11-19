/// <reference path="./types.d.ts" />

import { spawnSync } from "node:child_process";
import { numberedOptionIndex, numberedSelect } from "./ui.js";
import {
	applyEditOnce,
	buildEditorInvocation,
	collectRepeatCalls,
	extractText,
	getExternalEditor,
	getRepeatLabel,
	getSearchInputCharacter,
	resolvePath,
} from "./repeat-core.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text, getKeybindings, truncateToWidth, type SelectItem } from "@earendil-works/pi-tui";

async function openExternalEditor(
	ctx: any,
	filePath: string,
	line?: number,
): Promise<boolean> {
	const editorCommand = getExternalEditor();
	if (!editorCommand) return false;

	const runEditor = (tui?: any) => {
		const { command, args } = buildEditorInvocation(editorCommand, filePath, line);
		let ok = false;
		try {
			if (tui) tui.stop();
			const result = spawnSync(command, args, { stdio: "inherit" });
			ok = result.status === 0;
		} catch {
			ok = false;
		} finally {
			if (tui) {
				tui.start();
				tui.requestRender(true);
			}
		}
		return ok;
	};

	if (!ctx?.ui?.custom) {
		return runEditor();
	}

	return new Promise<boolean>((resolve) => {
		void ctx.ui.custom((tui, theme, _kb, done) => {
			const text = new Text(theme.fg("accent", "Opening external editor..."), 1, 1);
			setTimeout(() => {
				const ok = runEditor(tui);
				done(ok);
			}, 0);
			return text;
		}).then((result: boolean) => resolve(result));
	});

}

async function editContentInExternalEditor(
	ctx: any,
	initialContent: string,
): Promise<{ content: string; saved: boolean } | null> {
	const editorCommand = getExternalEditor();
	if (!editorCommand) return null;

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-repeat-"));
	const tmpFile = path.join(tmpDir, "repeat-write.txt");
	fs.writeFileSync(tmpFile, initialContent, "utf-8");
	let initialMtime = 0;
	try {
		initialMtime = fs.statSync(tmpFile).mtimeMs;
	} catch {
		initialMtime = 0;
	}

	try {
		const ok = await openExternalEditor(ctx, tmpFile);
		if (!ok) return null;
		let saved = false;
		try {
			saved = fs.statSync(tmpFile).mtimeMs !== initialMtime;
		} catch {
			saved = false;
		}
		return { content: fs.readFileSync(tmpFile, "utf-8"), saved };
	} finally {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	}
}
async function showRepeatPicker(ctx: any, items: SelectItem[]): Promise<string | null> {
	return ctx.ui.custom((tui, theme, _kb, done) => {
		let searchQuery = "";
		let filteredItems = items;

		const buildSelectList = (listItems: SelectItem[]) => {
			const selectList = new SelectList(listItems, Math.min(Math.max(listItems.length, 1), 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);
			return selectList;
		};

		let selectList = buildSelectList(items);

		const applyFilter = () => {
			const tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);
			const filtered = tokens.length === 0
				? items
				: items.filter((item) => {
					const haystack = `${item.label ?? ""} ${item.description ?? ""}`.toLowerCase();
					return tokens.every((token) => haystack.includes(token));
				});
			filteredItems = filtered;
			selectList = buildSelectList(filteredItems);
		};

		const searchLine = {
			render: (width: number) => {
				const prompt = theme.fg("muted", "Type to search:");
				const queryText = searchQuery ? ` ${theme.fg("accent", searchQuery)}` : "";
				return [truncateToWidth(`  ${prompt}${queryText}`, width)];
			},
			invalidate: () => {},
		};

		const selectListWrapper = {
			render: (width: number) => selectList.render(width),
			invalidate: () => selectList.invalidate(),
		};

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold("Repeat tool call")), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(searchLine);
		container.addChild(new Spacer(1));
		container.addChild(selectListWrapper);

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "1-9 select • ↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				const kb = getKeybindings();
				if (kb.matches(data, "tui.select.cancel")) {
					if (searchQuery) {
						searchQuery = "";
						applyFilter();
						tui.requestRender();
						return;
					}
					selectList.handleInput(data);
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.editor.deleteCharBackward")) {
					if (searchQuery.length > 0) {
						searchQuery = searchQuery.slice(0, -1);
						applyFilter();
						tui.requestRender();
						return;
					}
				}

				const numberedIndex = numberedOptionIndex(data, filteredItems.length);
				if (numberedIndex !== undefined) {
					done(filteredItems[numberedIndex].value);
					return;
				}

				const searchChar = getSearchInputCharacter(data);
				if (searchChar) {
					searchQuery += searchChar;
					applyFilter();
					tui.requestRender();
					return;
				}

				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("repeat", {
		description: "Repeat a previous bash/edit/write tool call",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive mode required.", "error");
				return;
			}

			const branchEntries = ctx.sessionManager.getBranch();
			const calls = collectRepeatCalls(branchEntries).reverse();

			if (calls.length === 0) {
				ctx.ui.notify("No bash/edit/write tool calls in the current branch.", "info");
				return;
			}

			const items: SelectItem[] = calls.map((call, index) => {
				const info = getRepeatLabel(call);
				return {
					value: String(index),
					label: info.label,
					description: info.description,
				};
			});

			const selection = await showRepeatPicker(ctx, items);
			if (selection === null) return;

			const selected = calls[Number(selection)];
			if (!selected) return;

			const externalEditor = getExternalEditor();

			if (selected.toolName === "bash") {
				const command = String(selected.args?.command ?? "");
				if (!command.trim()) {
					ctx.ui.notify("No bash command found to repeat.", "warning");
					return;
				}
				ctx.ui.setEditorText(`!${command}`);
				ctx.ui.notify("Loaded bash command into editor. Edit and press Enter to run.", "info");
				return;
			}

			if (selected.toolName === "write") {
				const targetPath = String(selected.args?.path ?? "");
				const content = String(selected.args?.content ?? "");
				if (!targetPath) {
					ctx.ui.notify("Write call is missing a path.", "error");
					return;
				}

				let mode: "repeat" | "edit" = "repeat";
				if (externalEditor) {
					const choice = await numberedSelect(ctx, "Repeat write:", [
						"Re-write same content",
						"Open in $EDITOR",
					]);
					if (!choice) return;
					mode = choice.startsWith("Open") ? "edit" : "repeat";
				}

				const absolutePath = resolvePath(ctx.cwd, targetPath);

				if (externalEditor) {
					const baseContent = mode === "edit"
						? (() => {
							if (fs.existsSync(absolutePath)) {
								try {
									return fs.readFileSync(absolutePath, "utf-8");
								} catch {
									return content;
								}
							}
							return content;
						})()
						: content;

					const edited = await editContentInExternalEditor(ctx, baseContent);
					if (edited === null) return;
					if (!edited.saved) {
						ctx.ui.notify("No changes saved.", "info");
						return;
					}

					const writeTool = createWriteTool(ctx.cwd);
					try {
						const result = await writeTool.execute("repeat-write", { path: targetPath, content: edited.content }, undefined);
						ctx.ui.notify(extractText(result.content) || "Write completed.", "info");
					} catch (error: any) {
						ctx.ui.notify(`Write failed: ${error?.message || String(error)}`, "error");
					}
					return;
				}

				if (mode === "edit") {
					ctx.ui.notify("$EDITOR not configured; cannot open file for write edit.", "warning");
					return;
				}

				const writeTool = createWriteTool(ctx.cwd);
				try {
					const result = await writeTool.execute("repeat-write", { path: targetPath, content }, undefined);
					ctx.ui.notify(extractText(result.content) || "Write completed.", "info");
				} catch (error: any) {
					ctx.ui.notify(`Write failed: ${error?.message || String(error)}`, "error");
				}
				return;
			}

			if (selected.toolName === "edit") {
				const targetPath = String(selected.args?.path ?? "");
				if (!targetPath) {
					ctx.ui.notify("Edit call is missing a path.", "error");
					return;
				}

				let mode: "repeat" | "open" = "repeat";
				if (externalEditor) {
					const choice = await numberedSelect(ctx, "Repeat edit:", [
						"Repeat the Edit",
						"Open file at changed line",
					]);
					if (!choice) return;
					mode = choice.startsWith("Open") ? "open" : "repeat";
				}

				if (mode === "repeat") {
					const oldText = String(selected.args?.oldText ?? "");
					const newText = String(selected.args?.newText ?? "");
					const absolutePath = resolvePath(ctx.cwd, targetPath);

					if (externalEditor) {
						if (!fs.existsSync(absolutePath)) {
							ctx.ui.notify(`File not found: ${targetPath}`, "error");
							return;
						}
						let originalContent = "";
						try {
							originalContent = fs.readFileSync(absolutePath, "utf-8");
						} catch (error: any) {
							ctx.ui.notify(`Failed to read ${targetPath}: ${error?.message || String(error)}`, "error");
							return;
						}

						const applied = applyEditOnce(originalContent, oldText, newText);
						if ("error" in applied) {
							ctx.ui.notify(`Repeat edit failed: ${applied.error}`, "warning");
							return;
						}

						const edited = await editContentInExternalEditor(ctx, applied.content);
						if (edited === null) return;
						if (!edited.saved) {
							ctx.ui.notify("No changes saved.", "info");
							return;
						}

						const writeTool = createWriteTool(ctx.cwd);
						try {
							const result = await writeTool.execute(
								"repeat-edit",
								{ path: targetPath, content: edited.content },
								undefined,
							);
							ctx.ui.notify(extractText(result.content) || "Edit completed.", "info");
						} catch (error: any) {
							ctx.ui.notify(`Edit failed: ${error?.message || String(error)}`, "error");
						}
						return;
					}

					const editTool = createEditTool(ctx.cwd);
					try {
						const result = await editTool.execute("repeat-edit", { path: targetPath, oldText, newText }, undefined);
						ctx.ui.notify(extractText(result.content) || "Edit completed.", "info");
					} catch (error: any) {
						ctx.ui.notify(`Edit failed: ${error?.message || String(error)}`, "error");
					}
					return;
				}

				if (!externalEditor) {
					ctx.ui.notify("$EDITOR not configured; cannot open file for edit repeat.", "warning");
					return;
				}

				const details = selected.resultDetails as { firstChangedLine?: number } | undefined;
				const line = details?.firstChangedLine ?? 1;
				const absolutePath = resolvePath(ctx.cwd, targetPath);
				if (!fs.existsSync(absolutePath)) {
					ctx.ui.notify(`File not found: ${targetPath}`, "error");
					return;
				}

				const ok = await openExternalEditor(ctx, absolutePath, line);
				if (!ok) {
					ctx.ui.notify("Editor closed without success.", "warning");
				}
				return;
			}
		},
	});
}
