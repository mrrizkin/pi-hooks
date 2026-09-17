const extensions = [
  "../checkpoint/checkpoint.ts",
  "../lsp/lsp.ts",
  "../lsp/lsp-tool.ts",
  "../permission/permission.ts",
  "../ralph-loop/ralph-loop.ts",
  "../repeat/repeat.ts",
  "../token-rate/token-rate.ts",
];

for (const extension of extensions) {
  await import(extension);
  console.log(`smoke import ok: ${extension}`);
}
