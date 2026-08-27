/** Vite serves an imported asset as a fingerprinted URL string. */
declare module '*.svg' {
  const url: string;
  export default url;
}
