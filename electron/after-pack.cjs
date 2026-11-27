// electron-builder drops every node_modules/*/examples folder, but three.js keeps
// OrbitControls and other modules there. Copy it back into the packed app.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async ({ appOutDir, packager }) => {
  const app = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app');
  const src = path.join(packager.projectDir, 'node_modules', 'three', 'examples', 'jsm');
  fs.cpSync(src, path.join(app, 'node_modules', 'three', 'examples', 'jsm'), { recursive: true });
};
