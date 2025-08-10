const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');

async function build() {
  const distPath = path.join(__dirname, 'dist');
  
  // Ensure dist directory exists
  if (!fs.existsSync(distPath)) {
    fs.mkdirSync(distPath, { recursive: true });
  }

  try {
    await esbuild.build({
      entryPoints: ['src/main.js'],
      bundle: true,
      outfile: 'main.js',
      platform: 'node',
      external: ['obsidian'],
      format: 'cjs',
      target: 'es2016',
      logLevel: 'info',
      sourcemap: production ? false : 'inline',
      minify: production,
      define: {
        'process.env.NODE_ENV': production ? '"production"' : '"development"'
      }
    });

    // Copy manifest.json and styles.css to root (for Obsidian)
    const manifestSrc = path.join(__dirname, 'manifest.json');
    const stylesSrc = path.join(__dirname, 'styles.css');
    
    // Also copy to dist for distribution
    const manifestDest = path.join(distPath, 'manifest.json');
    const stylesDest = path.join(distPath, 'styles.css');
    const mainDest = path.join(distPath, 'main.js');
    
    fs.copyFileSync(manifestSrc, manifestDest);
    if (fs.existsSync(stylesSrc)) {
      fs.copyFileSync(stylesSrc, stylesDest);
    }
    
    // Copy main.js to dist
    fs.copyFileSync('main.js', mainDest);
    
    console.log('✓ Build complete!');
    console.log('✓ Output files:');
    console.log('  - main.js (for development in plugin folder)');
    console.log('  - dist/main.js (bundled plugin)');
    console.log('  - dist/manifest.json');
    console.log('  - dist/styles.css');
    
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();