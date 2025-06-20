const  { nativeNodeModulesPlugin }  = require("esbuild-native-node-modules-plugin");
const { platform } = require("os");

// Build extension
require('esbuild').build({
    sourcemap:true,
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    outfile: 'out/extension.js',
    plugins: platform=="win32"?[]:[nativeNodeModulesPlugin],
    external: ['vscode'],
    format:'cjs',
    platform:'node'
    //loader: { '.png': 'binary' },
  }).catch(() => process.exit(1))

// Build debug adapter
require('esbuild').build({
    sourcemap:true,
    entryPoints: ['./src/debugAdapter.ts'],
    bundle: true,
    outfile: 'out/debugAdapter.js',
    plugins: platform=="win32"?[]:[nativeNodeModulesPlugin],
    external: ['vscode'],
    format:'cjs',
    platform:'node'
    //loader: { '.png': 'binary' },
  }).catch(() => process.exit(1))