/**
 * Minimal typings for the parts of imagetracerjs this engine uses.
 *
 * The engine drives the library's low-level pipeline (layering → pathscan →
 * internodes → batchtracepaths) rather than `imagedataToSVG`, because we supply
 * our own palette/quantization and emit our own SVG. See src/engine/trace.ts.
 */
declare module 'imagetracerjs' {
  export interface ItPoint {
    x: number;
    y: number;
    linesegment: number;
  }

  export type ItSegment =
    | { type: 'L'; x1: number; y1: number; x2: number; y2: number }
    | { type: 'Q'; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number };

  export interface ItPath {
    points: ItPoint[];
    boundingbox: [number, number, number, number];
    holechildren: number[];
    isholepath: boolean;
  }

  export interface ItTracedPath {
    segments: ItSegment[];
    boundingbox: [number, number, number, number];
    holechildren: number[];
    isholepath: boolean;
  }

  export interface ItOptions {
    ltres: number;
    qtres: number;
    rightangleenhance: boolean;
    [key: string]: unknown;
  }

  export interface ItIndexedImage {
    array: number[][];
    palette: Array<{ r: number; g: number; b: number; a: number }>;
  }

  interface ImageTracerApi {
    versionnumber: string;
    layeringstep(ii: ItIndexedImage, colorNumber: number): number[][];
    pathscan(layer: number[][], pathomit: number): ItPath[];
    internodes(paths: ItPath[], options: ItOptions): ItPath[];
    batchtracepaths(paths: ItPath[], ltres: number, qtres: number): ItTracedPath[];
  }

  const ImageTracer: ImageTracerApi;
  export default ImageTracer;
}
