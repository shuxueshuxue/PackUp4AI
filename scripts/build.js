const fs = require('fs');
const path = require('path');

console.log('Building Obsidian plugin...');

// Define paths
const srcPath = path.join(__dirname, '..', 'src', 'main.js');
const d3Path = path.join(__dirname, '..', 'lib', 'd3.min.js');
const distPath = path.join(__dirname, '..', 'dist');
const outputPath = path.join(distPath, 'main.js');

// Ensure dist directory exists
if (!fs.existsSync(distPath)) {
  fs.mkdirSync(distPath, { recursive: true });
}

// Read files
console.log('Reading source from:', srcPath);
let mainCode = fs.readFileSync(srcPath, 'utf8');
let d3Code = fs.readFileSync(d3Path, 'utf8');

// Remove the require('d3') line and module.exports
mainCode = mainCode.replace("const d3 = require('d3');", '');
mainCode = mainCode.replace(/^module\.exports = Packup4AIPlugin;$/m, '');

// Force D3 to use browser mode by removing the module detection
// Replace the UMD pattern to always use the browser global path
d3Code = d3Code.replace(
  '!function(t,n){"object"==typeof exports&&"undefined"!=typeof module?n(exports):"function"==typeof define&&define.amd?define(["exports"],n):n((t="undefined"!=typeof globalThis?globalThis:t||self).d3=t.d3||{})}(this,(function(t){',
  '!function(t,n){n((t="undefined"!=typeof globalThis?globalThis:t||self||window).d3=t.d3||{})}(window,(function(t){'
);

// Create the bundled content
const bundledContent = `// Obsidian Plugin with D3
// Force D3 to load into window.d3
${d3Code}

// Verify D3 loaded
if (window.d3) {
  console.log('D3 loaded successfully');
} else {
  console.error('D3 failed to load');
}

// Plugin code
${mainCode}

// Export for Obsidian
module.exports = Packup4AIPlugin;`;

// Write the bundled file
fs.writeFileSync(outputPath, bundledContent);

// Copy manifest.json and styles.css to dist
const manifestSrc = path.join(__dirname, '..', 'manifest.json');
const manifestDest = path.join(distPath, 'manifest.json');
const stylesSrc = path.join(__dirname, '..', 'styles.css');
const stylesDest = path.join(distPath, 'styles.css');

fs.copyFileSync(manifestSrc, manifestDest);
if (fs.existsSync(stylesSrc)) {
  fs.copyFileSync(stylesSrc, stylesDest);
}

console.log('✓ Build complete!');
console.log('✓ Output files in dist/ folder:');
console.log('  - dist/main.js (bundled plugin)');
console.log('  - dist/manifest.json');
console.log('  - dist/styles.css');
console.log('\nFor development: Use files from the dist/ folder in Obsidian');
console.log('For release: Create a zip of the dist/ folder contents');