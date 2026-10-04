/** Vite's `?inline`: the stylesheet, imports resolved, as a string. */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
