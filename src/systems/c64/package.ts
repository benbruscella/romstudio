/** Browser dependencies of this machine, supplied explicitly to the packager. */
export const c64BrowserPackage = {
  id: 'c64',
  runtime: 'shared-c64-player',
  inputFormat: 'joystick-and-keyboard-matrix',
  width: 320,
  height: 200,
  modules: [
    'systems/c64.js',
    ...[
      'cia',
      'vic',
      'kernal',
      'system',
      'render',
      'snapshot',
      'raster',
      'input',
      'sid-audio',
      'player',
    ].map((name) => `systems/c64/${name}.js`),
  ],
};
