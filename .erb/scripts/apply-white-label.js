/**
 * White Label Build Script
 *
 * This script reads the white label configuration and updates the index.ejs and package.json
 * files with the appropriate values. It should be run as part of the build process.
 */

const fs = require('fs');
const path = require('path');

// Import the white label configuration
// Note: We need to use require() to load the compiled JS file, not the TS source
try {
  // Paths
  const configPath = path.resolve(
    __dirname,
    '../../dist/main/whiteLabel.config.js',
  );
  const indexEjsPath = path.resolve(__dirname, '../../src/renderer/index.ejs');
  const packageJsonPath = path.resolve(__dirname, '../../package.json');

  console.log('Applying white label configuration...');

  // Check if the compiled config exists
  if (!fs.existsSync(configPath)) {
    console.error(`White label config not found at ${configPath}`);
    console.log(
      'Make sure to build the project first with "npm run build" or "npm start"',
    );
    process.exit(1);
  }

  // Load the white label configuration
  // We need to clear the require cache in case the script is run multiple times
  delete require.cache[require.resolve(configPath)];
  const whiteLabelConfig = require(configPath).default;

  console.log('Loaded white label configuration:', whiteLabelConfig.app.name);

  // Update index.ejs
  console.log('Updating index.ejs...');
  let indexEjsContent = fs.readFileSync(indexEjsPath, 'utf8');

  // Replace the title
  indexEjsContent = indexEjsContent.replace(
    /<title>.*<\/title>/,
    `<title>${whiteLabelConfig.app.productName}</title>`,
  );

  fs.writeFileSync(indexEjsPath, indexEjsContent);
  console.log('Updated index.ejs');

  // Update package.json
  console.log('Updating package.json...');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  // Update package.json values
  packageJson.name = whiteLabelConfig.app.name
    .toLowerCase()
    .replace(/\s+/g, '-');
  packageJson.description = whiteLabelConfig.app.description;

  // Update build configuration
  if (packageJson.build) {
    packageJson.build.productName = whiteLabelConfig.app.productName;
    packageJson.build.appId = `com.${whiteLabelConfig.app.name.toLowerCase().replace(/\s+/g, '')}.app`;
  }

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
  console.log('Updated package.json');

  console.log('White label configuration applied successfully!');
} catch (error) {
  console.error('Error applying white label configuration:', error);
  process.exit(1);
}
