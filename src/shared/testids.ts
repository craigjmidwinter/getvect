/**
 * Single source of truth for `data-testid` values.
 *
 * The renderer MUST render these ids and the e2e suite selects on them.
 * Human-readable documentation of the surrounding DOM contract (attributes,
 * state, events) lives in docs/TESTIDS.md — keep the two in sync.
 */
export const TESTIDS = {
  // --- A. Launch & ingest ---------------------------------------------------
  appRoot: 'app-root',
  dropZone: 'drop-zone',
  filePickerButton: 'file-picker-button',
  fileInput: 'file-input', // real <input type="file" multiple> — how e2e injects files
  errorToast: 'error-toast',
  imageList: 'image-list',
  imageListItem: 'image-list-item', // + data-image-id, data-selected
  imageListItemName: 'image-list-item-name',
  imageRemoveButton: 'image-remove-button',

  // --- B. Vectorization engine ---------------------------------------------
  workspace: 'workspace',
  progressIndicator: 'progress-indicator', // + data-progress 0..1
  statusText: 'status-text', // + data-status idle|loading|vectorizing|ready|error
  settingsPanel: 'settings-panel',
  settingColorCount: 'color-count',
  settingDetail: 'detail',
  settingSmoothing: 'smoothing',
  settingDespeckle: 'despeckle',
  enhanceToggle: 'enhance-toggle',
  revectorizeButton: 'revectorize-button',
  resetSettingsButton: 'reset-settings-button',

  paletteEditor: 'palette-editor',
  paletteSwatch: 'palette-swatch', // + data-color, data-index
  paletteColorInput: 'palette-color-input',
  paletteMergeButton: 'palette-merge-button',
  paletteMergeTarget: 'palette-merge-target',
  paletteRemoveButton: 'palette-remove-button',

  // --- C. Preview -----------------------------------------------------------
  previewPane: 'preview-pane', // + data-mode original|vector|side-by-side
  previewOriginal: 'preview-original',
  previewVector: 'preview-vector', // contains the live <svg>
  previewToggle: 'preview-toggle',
  previewSideBySide: 'preview-side-by-side',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  zoomFit: 'zoom-fit',
  zoomLevel: 'zoom-level', // + data-zoom (1 === 100%)
  panState: 'pan-state', // + data-pan-x, data-pan-y

  // --- D. Export ------------------------------------------------------------
  exportSvg: 'export-svg',
  exportEps: 'export-eps',
  exportDxf: 'export-dxf',
  exportStatus: 'export-status', // + data-last-export-path
} as const;

export type TestId = (typeof TESTIDS)[keyof typeof TESTIDS];
