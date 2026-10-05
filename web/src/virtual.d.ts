// Modules the build makes (web/vite.config.ts).
declare module "virtual:builtin-copies" {
  /** Each built-in's files as Customize copies them: JavaScript, by name. */
  const copies: Record<string, Record<string, string>>;
  export default copies;
}
