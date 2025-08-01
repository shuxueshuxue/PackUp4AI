const fs = require('fs');
const path = require('path');

console.log('Building plugin...');

// Read the source file
let mainCode = fs.readFileSync('./src/main.js', 'utf8');

// Read d3.min.js
const d3Code = fs.readFileSync('./d3.min.js', 'utf8');

// Remove the require('d3') line
mainCode = mainCode.replace("const d3 = require('d3');", '');

// Also remove any existing module.exports line to avoid duplication
mainCode = mainCode.replace(/^module\.exports = Packup4AIPlugin;$/m, '');

// Create the bundled content
const bundledContent = `// D3.js library embedded
(function() {
  const window = globalThis || this || {};
  ${d3Code}
  if (!window.d3) {
    console.error('D3 failed to load properly');
  }
})();

// Make d3 available to the plugin
const d3 = (globalThis || this || {}).d3;
if (!d3) {
  console.error('D3 is not available after loading');
}

// Plugin code starts here
${mainCode}

// Export for Obsidian
module.exports = Packup4AIPlugin;`;

// Write the bundled file
fs.writeFileSync('./main.js', bundledContent);

console.log('✓ Build complete!');
console.log('✓ Created main.js with d3 bundled');
console.log('\nThe plugin is ready to use in Obsidian!');