declare module "node:child_process" {
	export const spawn: any;
	export const spawnSync: any;
}

declare module "node:crypto" {
	const crypto: any;
	export = crypto;
}

declare namespace fs {
	export type Dirent = any;
}

declare module "node:fs" {
	const fs: any;
	export = fs;
}

declare module "node:os" {
	const os: any;
	export = os;
}

declare module "node:path" {
	const path: any;
	export = path;
}

declare module "@earendil-works/pi-agent-core" {
	export type AgentToolResult = any;
}

declare module "@earendil-works/pi-ai" {
	export type TextContent = { type: "text"; text: string; textSignature?: string };
	export type ImageContent = { type: "image"; data: string; mimeType: string };
	export type Message = any;
	export const StringEnum: any;
	export const Type: any;
}

declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionAPI = any;
	export const getMarkdownTheme: any;
	export const initTheme: any;
	export const createBashToolDefinition: any;
	export const createEditToolDefinition: any;
	export const createFindToolDefinition: any;
	export const createGrepToolDefinition: any;
	export const createLsToolDefinition: any;
	export const createReadToolDefinition: any;
	export const createWriteToolDefinition: any;
	export const formatSize: any;
	export const truncateTail: any;
	export class AssistantMessageComponent {
		constructor(...args: any[]);
	}
	export class DynamicBorder {
		constructor(...args: any[]);
	}
	export class ToolExecutionComponent {
		constructor(...args: any[]);
		updateResult(...args: any[]): void;
		setExpanded(...args: any[]): void;
	}
	export class UserMessageComponent {
		constructor(...args: any[]);
	}
}

declare module "@earendil-works/pi-tui" {
	export interface Component {
		render(width: number): string[];
		invalidate(): void;
		handleInput?(data: string): void;
		dispose?(): void;
	}
	export class Box {
		constructor(...args: any[]);
		addChild(...args: any[]): void;
		clear(): void;
		setBgFn(...args: any[]): void;
	}
	export class Container {
		children: any[];
		constructor(...args: any[]);
		addChild(...args: any[]): void;
		removeChild(...args: any[]): void;
		clear(): void;
		invalidate(): void;
		render(...args: any[]): any;
	}
	export const truncateToWidth: any;
	export const visibleWidth: any;
	export const wrapTextWithAnsi: any;
	export class Markdown {
		constructor(...args: any[]);
		setText(...args: any[]): void;
	}
	export class Spacer {
		constructor(...args: any[]);
	}
	export class Text {
		constructor(...args: any[]);
		setText(...args: any[]): void;
	}
	export const matchesKey: any;
}

declare const process: any;
